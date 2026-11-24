import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import {
  attachColumnName,
  buildRecordView,
  downloadRecordAttachments,
  indexLocalRecords,
  listFeishuFields,
  listFeishuRecords,
  loadColumnNames,
  rowsFingerprint,
  scanLocalRecords,
  type AttachmentInfo,
  type TableRecordView,
} from "./lark-read.ts"
import { runPool } from "./concurrency.ts"
import { estimateCost, priceFor, readModelPrices } from "./model-prices.ts"
import { transcribeImageFile } from "./vl-transcribe.ts"
import {
  assignReplayNumbers,
  averageUsage,
  rLabel,
  summarizeRecords,
  toSummaries,
  type ReplayManifest,
  type ReplayPlanNumbers,
  type ReplayRecordDetail,
  type ReplayShotRef,
} from "./replay-model.ts"
import {
  cachedImageFile,
  cachedTranscriptFile,
  fileSha256,
  importMediaFrom,
  importTranscriptFrom,
  incomingDir,
  loadT25Cache,
  readRecordDetail,
  readReplayManifest,
  sampleUsageFromCache,
  snapshotFileExists,
  t25SeqMap,
  snapshotDir,
  transcriptsDir,
  writeJsonAtomic,
  writeRecordDetail,
  writeReplayManifest,
} from "./replay-store.ts"

/**
 * T26：从飞书正式表只读生成本地回放快照（D21）。
 *
 * 只有这一份实现：页面 API（/api/replay/snapshot）和 scripts/replay-snapshot.mjs
 * 都调用这里的 plan / apply。
 * - plan：只读飞书 + 只读本地，算出「要读多少条、新增多少、复制多少文件多大、费用耗时」。
 * - apply：下载缺的截图、复制 T25 缓存、转写新图，写 KB_DIR/replay/snapshot/。**从不写飞书**。
 *
 * Script-safe: no `server-only`, `.ts` suffix on relative runtime imports.
 */

export type ReplayConfig = {
  kbDir: string
  cliPath: string
  baseToken: string
  tableId: string
  source: "prod" | "test"
  dashscopeKey: string
  dashscopeBase: string
  vlModel: string
  workDir: string
  concurrency: number
}

export type ConfigResult = { ok: true; cfg: ReplayConfig } | { ok: false; error: string }

export function replayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { workDir?: string } = {},
): ConfigResult {
  const kbDir = env.KB_DIR?.trim() ?? ""
  const baseToken = env.LARK_BASE_TOKEN?.trim() ?? ""
  const tableId = env.LARK_PROD_TABLE_ID?.trim() || env.LARK_TABLE_ID?.trim() || ""
  const missing: string[] = []
  if (!kbDir) missing.push("KB_DIR")
  if (!baseToken) missing.push("LARK_BASE_TOKEN")
  if (!tableId) missing.push("LARK_PROD_TABLE_ID")
  if (missing.length) return { ok: false, error: `缺少配置：${missing.join("、")}（只写在 .env.local）` }
  const testTable = env.LARK_TABLE_ID?.trim() ?? ""
  return {
    ok: true,
    cfg: {
      kbDir,
      cliPath: env.LARK_CLI_PATH?.trim() || "lark-cli",
      baseToken,
      tableId,
      source: testTable && testTable === tableId ? "test" : "prod",
      dashscopeKey: env.DASHSCOPE_API_KEY?.trim() ?? "",
      dashscopeBase: (env.DASHSCOPE_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, ""),
      vlModel: env.DASHSCOPE_VL_MODEL?.trim() || "",
      workDir: overrides.workDir || path.join(kbDir, "exports", "_t25-work"),
      concurrency: Math.max(1, Math.min(Number(env.REPLAY_CONCURRENCY) || 4, 8)),
    },
  }
}

type ImageAction = "reuse" | "copy" | "fresh"

type ImageWork = {
  att: AttachmentInfo
  action: ImageAction
  /** copy：T25 缓存里的截图文件。fresh：下载后才知道。 */
  sourceFile?: string
  /** 已有逐图转写文件（T25 缓存）。 */
  transcriptSource?: string
  /** reuse：快照里已有的 shot。 */
  shot?: ReplayShotRef
  /** 内容哈希（copy/reuse 时计划期已知）。 */
  hash?: string
}

type RecordWork = {
  view: TableRecordView
  r: string
  numberSource: "t25" | "new"
  changed: boolean
  needsDownload: boolean
  images: ImageWork[]
  existing: ReplayRecordDetail | null
}

export type ReplayPlan = {
  numbers: ReplayPlanNumbers
  /** 已分配的最大 R 序号（用于让 manifest 的编号只增不减）。 */
  seqUsed: number
  works: RecordWork[]
}

async function collect(cfg: ReplayConfig): Promise<{ plan: ReplayPlan; manifest: ReplayManifest | null }> {
  const target = { cliPath: cfg.cliPath, baseToken: cfg.baseToken, tableId: cfg.tableId }
  const fieldList = await listFeishuFields(target)
  const columnNames = await loadColumnNames(cfg.kbDir)
  columnNames.attachment = attachColumnName(fieldList, columnNames)
  const { columns, records } = await listFeishuRecords(target)
  const localIndex = indexLocalRecords(await scanLocalRecords(cfg.kbDir))
  const views = records.map((r) => buildRecordView(r, columns, columnNames, localIndex))

  const manifestState = await readReplayManifest(cfg.kbDir)
  if (!manifestState.ok) throw new Error(manifestState.error)
  const manifest = manifestState.manifest

  const existingByRecordId = new Map<string, ReplayRecordDetail>()
  for (const summary of manifest?.records ?? []) {
    const detail = await readRecordDetail(cfg.kbDir, summary.r)
    if (detail) existingByRecordId.set(detail.recordId, detail)
  }

  const cache = await loadT25Cache(cfg.workDir)
  const existingNumbers: Record<string, string> = {}
  for (const summary of manifest?.records ?? []) existingNumbers[summary.recordId] = summary.r

  const numbered = assignReplayNumbers({
    existing: existingNumbers,
    t25: t25SeqMap(cache),
    incoming: views.map((v) => ({ recordId: v.recordId, date: v.date })),
    seqUsed: manifest?.seq ?? 0,
  })

  const works: RecordWork[] = []
  let newRecords = 0
  let newScreenshots = 0
  let reuseScreenshots = 0
  let copyScreenshotFiles = 0
  let copyScreenshotBytes = 0
  let copyTranscriptFiles = 0
  let copyTranscriptBytes = 0
  let downloadRecords = 0
  let downloadImages = 0
  let transcribeImages = 0

  for (const view of views) {
    const r = numbered.numbers[view.recordId]
    const existing = existingByRecordId.get(view.recordId) ?? null
    if (!existing) newRecords++
    const images: ImageWork[] = []
    const shots = view.attachments.filter((a) => a.kind === "image")

    for (const att of shots) {
      const ref = existing?.attachments.find((a) => a.token === att.token)
      const oldShot = ref?.hash ? existing?.shots.find((s) => s.hash === ref.hash) : undefined
      if (oldShot && snapshotFileExists(cfg.kbDir, oldShot.file) && snapshotFileExists(cfg.kbDir, oldShot.transcript)) {
        images.push({ att, action: "reuse", shot: oldShot, hash: oldShot.hash })
        reuseScreenshots++
        continue
      }
      const cacheImage = cachedImageFile(cache, view.recordId, att.token)
      const cacheTranscript = cachedTranscriptFile(cache, att.token)
      if (cacheImage) {
        const hash = await fileSha256(cacheImage)
        const hasMedia = snapshotFileExists(cfg.kbDir, `media/${hash}${path.extname(cacheImage).toLowerCase()}`)
        const hasTranscript = snapshotFileExists(cfg.kbDir, `transcripts/${hash}.json`)
        if (!hasMedia) {
          copyScreenshotFiles++
          copyScreenshotBytes += (await fsp.stat(cacheImage)).size
        }
        if (!hasMedia || !hasTranscript) newScreenshots++
        if (!hasTranscript && cacheTranscript) {
          copyTranscriptFiles++
          copyTranscriptBytes += (await fsp.stat(cacheTranscript)).size
        }
        // 已经在快照里（同内容）也走 copy：importMediaFrom / importTranscriptFrom 不重复写。
        images.push({
          att,
          action: "copy",
          sourceFile: cacheImage,
          transcriptSource: cacheTranscript ?? undefined,
          hash,
        })
        continue
      }
      // 缓存里没有这张截图：只能从飞书下载，下载后再转写。
      images.push({ att, action: "fresh", transcriptSource: cacheTranscript ?? undefined })
      newScreenshots++
      downloadImages++
      transcribeImages++
    }

    const needsDownload = images.some((i) => i.action === "fresh")
    if (needsDownload) downloadRecords++
    const changed =
      !existing ||
      images.length !== existing.shots.length ||
      images.some((i) => i.action !== "reuse") ||
      view.attachments.length !== existing.attachments.length
    const t25Seq = cache?.records[view.recordId]?.seq
    const numberSource: "t25" | "new" = t25Seq && r === rLabel(t25Seq) ? "t25" : "new"

    works.push({ view, r, numberSource, changed, needsDownload, images, existing })
  }

  // 费用与耗时：只算真正要转写的图；单价来自私有配置（坑 20，不自己编数字）。
  const samples = await sampleUsageFromCache(cache)
  const avg = averageUsage(samples)
  const prices = await readModelPrices(cfg.kbDir)
  const price = priceFor(prices, cfg.vlModel)
  const estimatePromptTokens = Math.round(avg.promptTokens * transcribeImages)
  const estimateCompletionTokens = Math.round(avg.completionTokens * transcribeImages)
  const cost = estimateCost({ promptTokens: estimatePromptTokens, completionTokens: estimateCompletionTokens, price })
  const minutes = transcribeImages
    ? Math.max(1, Math.ceil((avg.ms * transcribeImages) / cfg.concurrency / 60_000))
    : 0

  const numbers: ReplayPlanNumbers = {
    source: cfg.source,
    tableRecords: records.length,
    tableAttachments: views.reduce((n, v) => n + v.attachments.length, 0),
    tableImages: views.reduce((n, v) => n + v.attachments.filter((a) => a.kind === "image").length, 0),
    snapshotRecords: manifest?.records.length ?? 0,
    snapshotShots: manifest?.counts.shots ?? 0,
    newRecords,
    newScreenshots,
    reuseScreenshots,
    copyScreenshotFiles,
    copyScreenshotBytes,
    copyTranscriptFiles,
    copyTranscriptBytes,
    downloadRecords,
    downloadImages,
    transcribeImages,
    nextR: rLabel(numbered.seqUsed + 1),
    lastR: rLabel(numbered.seqUsed),
    numbersFromT25: numbered.fromT25,
    numbersAssigned: numbered.assigned,
    numberConflicts: numbered.conflicts,
    estimatePromptTokens,
    estimateCompletionTokens,
    estimateCost: cost,
    estimateMinutes: minutes,
    priceSource: price
      ? `${prices.updatedAt || "未注明日期"} 的 KB_DIR/config/model-prices.json`
      : `model-prices.json 里没有 ${cfg.vlModel || "VL 模型"} 的单价，需用户核实`,
    fingerprint: rowsFingerprint(records),
  }

  return { plan: { numbers, seqUsed: numbered.seqUsed, works }, manifest }
}

/** 只读预览：不下载、不转写、不写任何文件。 */
export async function planReplaySnapshot(cfg: ReplayConfig): Promise<ReplayPlan> {
  const { plan } = await collect(cfg)
  return plan
}

export type ReplayApplyResult = {
  plan: ReplayPlanNumbers
  records: number
  written: number
  unchanged: number
  shots: number
  mediaCopied: number
  mediaBytes: number
  transcriptsCopied: number
  transcribed: number
  failures: number
  failureNotes: string[]
  fingerprintAfter: string
}

/**
 * 执行刷新：下载缺的截图、复制 T25 缓存、转写新图，写 snapshot/。
 * 单条记录失败不影响其它记录；失败的记录保留旧快照。
 * 结束时再读一次飞书做只读指纹对比，证明整轮没有写飞书。
 */
export async function applyReplaySnapshot(
  cfg: ReplayConfig,
  { onProgress }: { onProgress?: (done: number, total: number) => void } = {},
): Promise<ReplayApplyResult> {
  const { plan, manifest } = await collect(cfg)
  const target = { cliPath: cfg.cliPath, baseToken: cfg.baseToken, tableId: cfg.tableId }
  const failures: string[] = []
  const details = new Map<string, ReplayRecordDetail>()
  let written = 0
  let unchanged = 0
  let mediaCopied = 0
  let mediaBytes = 0
  let transcriptsCopied = 0
  let transcribed = 0

  for (const work of plan.works) {
    if (work.existing) details.set(work.view.recordId, work.existing)
  }

  let done = 0
  const poolSize = Math.max(1, Math.min(cfg.concurrency, 4))
  await runPool(plan.works, poolSize, async (work) => {
    try {
      if (!work.changed && work.existing) {
        unchanged++
        return
      }
      const recordId = work.view.recordId
      let incoming = new Map<string, string>()
      if (work.needsDownload) {
        const dest = path.join(incomingDir(cfg.kbDir), recordId)
        await fsp.mkdir(dest, { recursive: true })
        const files = await downloadRecordAttachments({ ...target, recordId, destDir: dest })
        incoming = new Map(files.map((f) => [f.token, f.savedPath]))
      }

      const shots: ReplayShotRef[] = []
      const attachments = work.view.attachments.map((a) => ({
        token: a.token,
        name: a.name,
        kind: a.kind,
        hash: undefined as string | undefined,
      }))

      for (const image of work.images) {
        let shot: ReplayShotRef
        if (image.action === "reuse" && image.shot) {
          shot = image.shot
        } else {
          const source = image.action === "fresh" ? incoming.get(image.att.token) ?? null : image.sourceFile ?? null
          if (!source) throw new Error("截图没拿到（既不在缓存里，也没下载下来）")
          const media = await importMediaFrom({ sourceFile: source, kbDir: cfg.kbDir, hash: image.hash })
          if (media.copied) {
            mediaCopied++
            mediaBytes += media.bytes
          }
          const transcriptRel = `transcripts/${media.hash}.json`
          let transcriptParsed: { isChat?: boolean; category?: string; model?: string; at?: string } | null = null
          if (image.transcriptSource && fs.existsSync(image.transcriptSource)) {
            const imported = await importTranscriptFrom({ sourceFile: image.transcriptSource, kbDir: cfg.kbDir, hash: media.hash })
            if (imported.copied) transcriptsCopied++
            transcriptParsed = await readJsonSafe(path.join(cfg.kbDir, "replay", "snapshot", imported.file))
          } else if (snapshotFileExists(cfg.kbDir, transcriptRel)) {
            transcriptParsed = await readJsonSafe(path.join(transcriptsDir(cfg.kbDir), `${media.hash}.json`))
          } else {
            if (!cfg.dashscopeKey || !cfg.vlModel) {
              throw new Error("缺少 DASHSCOPE_API_KEY / DASHSCOPE_VL_MODEL，无法转写新截图")
            }
            const result = await transcribeImageFile(source, {
              dashscopeKey: cfg.dashscopeKey,
              dashscopeBase: cfg.dashscopeBase,
              vlModel: cfg.vlModel,
            })
            if (!result.ok) throw new Error(`转写失败：${result.error}`)
            transcribed++
            transcriptParsed = { isChat: result.isChat, category: result.category, model: cfg.vlModel, at: new Date().toISOString() }
            await writeJsonAtomic(path.join(transcriptsDir(cfg.kbDir), `${media.hash}.json`), {
              hash: media.hash,
              model: cfg.vlModel,
              at: transcriptParsed.at,
              source: "snapshot",
              ...result,
            })
          }
          shot = {
            hash: media.hash,
            file: media.file,
            transcript: transcriptRel,
            isChat: transcriptParsed?.isChat === true,
            category: transcriptParsed?.category || "",
            model: transcriptParsed?.model ?? cfg.vlModel,
            at: transcriptParsed?.at,
          }
        }
        shots.push(shot)
        const mirror = attachments.find((a) => a.token === image.att.token)
        if (mirror) mirror.hash = shot.hash
      }

      const detail: ReplayRecordDetail = {
        r: work.r,
        recordId,
        title: work.view.title,
        date: work.view.date,
        customer: work.view.customer,
        localId: work.view.localId,
        problem: work.view.problem,
        solution: work.view.solution,
        attachments,
        shots,
        numberSource: work.numberSource,
        importedAt: new Date().toISOString(),
      }
      await writeRecordDetail(cfg.kbDir, detail)
      details.set(recordId, detail)
      written++
    } catch (e) {
      failures.push(`R${String(work.r)}：${(e as Error)?.message ?? e}`)
    } finally {
      done++
      onProgress?.(done, plan.works.length)
    }
  })

  // manifest：编号只增不减（seq 取历史上分配过的最大值）。
  const detailList = [...details.values()]
  const counts = summarizeRecords(detailList)
  const seq = Math.max(
    plan.seqUsed,
    manifest?.seq ?? 0,
    ...detailList.map((d) => Number(/^R(\d+)$/.exec(d.r)?.[1] ?? 0)),
    0,
  )
  const nextManifest: ReplayManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    source: cfg.source,
    seq,
    counts,
    records: toSummaries(detailList),
  }
  await writeReplayManifest(cfg.kbDir, nextManifest)

  // 只读复核：再读一次飞书，指纹一致 = 这轮没有写飞书。
  let fingerprintAfter = ""
  try {
    const again = await listFeishuRecords(target)
    fingerprintAfter = rowsFingerprint(again.records)
  } catch {
    fingerprintAfter = ""
  }

  // 失败明细只落盘（R 编号 + 原因），不进会话、不进报告。
  await writeJsonAtomic(path.join(snapshotDir(cfg.kbDir), "last-apply.json"), {
    at: new Date().toISOString(),
    records: detailList.length,
    written,
    unchanged,
    shots: counts.shots,
    mediaCopied,
    mediaBytes,
    transcriptsCopied,
    transcribed,
    failures: failures.length,
    failureNotes: failures,
    fingerprintBefore: plan.numbers.fingerprint,
    fingerprintAfter,
  })

  return {
    plan: plan.numbers,
    records: detailList.length,
    written,
    unchanged,
    shots: counts.shots,
    mediaCopied,
    mediaBytes,
    transcriptsCopied,
    transcribed,
    failures: failures.length,
    failureNotes: failures.slice(0, 10),
    fingerprintAfter,
  }
}

async function readJsonSafe(
  file: string,
): Promise<{ isChat?: boolean; category?: string; model?: string; at?: string } | null> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"))
  } catch {
    return null
  }
}
