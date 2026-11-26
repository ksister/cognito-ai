import "server-only"
import fs from "node:fs/promises"
import path from "node:path"
import { aiConfigured, aiModelName, extractRecordWithUsage } from "./ai"
import {
  buildExtractSystem,
  FeishuSchemaError,
  readRecordField,
  type FeishuTableSchema,
} from "./feishu-schema"
import { loadFeishuSchemaState } from "./feishu-schema-load"
import { estimateCost, priceFor, readModelPrices, type ModelPrice, type ModelPrices } from "./model-prices"
import { averageUsage, type TokenAverage } from "./replay-model"
import { loadCompanyPrefixes, loadSpeakersSettings } from "./speakers-config"
import { namesFromWindowTitle, resolveAndFormat } from "./speaker-resolve"
import {
  buildSnapshotTranscriptPrompt,
  buildTranscriptPromptV3,
  transcribeImageFile,
  TRANSCRIPT_PROMPT_VERSION_V1,
  TRANSCRIPT_PROMPT_VERSION_V3,
} from "./vl-transcribe"

/** 回放可选的转写提示词版本：v3（默认，v1 + 侧别规则）/ v1（对照用）。 */
export type ReplayTranscriptVersion = "transcript-v1" | "transcript-v3"

export function parseReplayTranscriptVersion(v: unknown): ReplayTranscriptVersion | null {
  if (v == null || v === "" || v === "v3" || v === TRANSCRIPT_PROMPT_VERSION_V3) return TRANSCRIPT_PROMPT_VERSION_V3
  if (v === "v1" || v === TRANSCRIPT_PROMPT_VERSION_V1) return TRANSCRIPT_PROMPT_VERSION_V1
  return null
}

function promptFor(version: ReplayTranscriptVersion): string {
  return version === TRANSCRIPT_PROMPT_VERSION_V1 ? buildSnapshotTranscriptPrompt() : buildTranscriptPromptV3()
}
import { runPool } from "./concurrency"
import {
  estimateReorganizeCost,
  estimateTokens,
  newRunId,
  type CostEstimate,
  type ReplayRun,
} from "./replay-result"
import { snapshotDir } from "./replay-store"
import { writeRun } from "./replay-results-store"
import type { ReplayRecordDetail } from "./replay-model"
import {
  dropTitleTurns,
  formatScreenshotChat,
  mergeTranscriptList,
  mergeUncertain,
  OCR_TRANSCRIPT_MARKER,
  type TranscriptTurn,
} from "./transcript"
import type { RecordDraft } from "./types"

/**
 * T27「只重跑整理」：用快照里已有的逐图转写重新出字段。
 *
 *  - 只读 KB_DIR/replay/snapshot/，不连飞书、不写飞书（D21/D22）。
 *  - 每次运行的结果写 KB_DIR/replay/results/<记录 ID>/<runId>.json（D21 历史）。
 *  - 先给预览（预计费用），用户确认后才真正调模型。
 *
 * 提示词版本：现行字段提示词（feishu-schema 的 buildExtractSystem）定为 fields-v1。
 * 改了提示词就要这里加版本，否则历史里两次运行看不出差别。
 */
export const FIELDS_PROMPT_VERSION = "fields-v1"

const MAX_TRANSCRIPT_CHARS = 30_000

export type SnapshotTranscript = {
  /** 按截图顺序拼接、去掉相邻重叠后的转写，首行是 OCR 标记。 */
  text: string
  turns: TranscriptTurn[]
  /** 有转写文件的截图数。 */
  shots: number
  /** 有截图但转写文件缺失/坏掉的张数。 */
  missingTranscripts: number
  /** 真正在聊天里的行数（不含标记行）。 */
  lines: number
}

/**
 * 从快照读出这条记录的完整转写：逐图转写按截图顺序拼接、去掉相邻截图的重叠。
 * 快照里存的是「每张图一份」，拼起来才是这条记录的原始聊天记录。
 */
export async function readSnapshotTranscript(kbDir: string, detail: ReplayRecordDetail): Promise<SnapshotTranscript> {
  const parts: TranscriptTurn[][] = []
  let shots = 0
  let missingTranscripts = 0
  for (const shot of detail.shots) {
    shots++
    let turns: TranscriptTurn[] = []
    let ok = false
    try {
      const json = JSON.parse(await fs.readFile(path.join(snapshotDir(kbDir), shot.transcript), "utf8")) as {
        turns?: TranscriptTurn[]
        isChat?: boolean
      }
      if (Array.isArray(json.turns) && json.isChat !== false) {
        turns = json.turns
        ok = true
      } else if (json.isChat === false) {
        // 非聊天截图（报错/界面/效果图）没有对话可拼，不算失败。
        ok = true
      }
    } catch {
      ok = false
    }
    if (!ok) missingTranscripts++
    parts.push(turns)
  }
  const prefixes = await loadCompanyPrefixes(kbDir)
  const merged = mergeTranscriptList(parts, prefixes)
  const text = formatScreenshotChat(merged)
  return {
    text,
    turns: merged,
    shots,
    missingTranscripts,
    lines: text.split("\n").filter((l) => l.trim() && l !== OCR_TRANSCRIPT_MARKER).length,
  }
}

/** 喂给文字模型的纯聊天内容：去掉我们自己加的那行 OCR 标记（T14 的规则）。 */
export function transcriptForModel(text: string): string {
  const lines = String(text ?? "").split("\n")
  if (lines[0]?.trim() === OCR_TRANSCRIPT_MARKER) return lines.slice(1).join("\n").trim()
  return lines.join("\n").trim()
}

/** 提取结果 → 对比用的字符串字段（多选用表结构的分隔符，和复制到飞书时一致）。 */
export function draftToFields(draft: Partial<RecordDraft>, schema: FeishuTableSchema): Record<string, string> {
  const out: Record<string, string> = {}
  for (const col of schema.columns) {
    if (!col.key) continue
    out[col.key] = readRecordField(draft, col.key)
  }
  return out
}

/** 左列：快照里存的飞书原字段；老快照没有 fields 时用明细里的几个字段兜底。 */
export function feishuFieldsFromDetail(detail: ReplayRecordDetail): Record<string, string> {
  if (detail.fields && Object.keys(detail.fields).length) return { ...detail.fields }
  return {
    title: detail.title,
    date: detail.date,
    customer: detail.customer,
    local_id: detail.localId,
    problem: detail.problem,
    solution: detail.solution,
  }
}

/**
 * 日期和客户：平时靠表单和聊天窗口标题补，回放里从快照补。
 * 这两列不是模型该判断的东西，补上之后对比界面不会再显示成「不同」。
 */
export function fillContextFields(
  fields: Record<string, string>,
  detail: ReplayRecordDetail,
): Record<string, string> {
  const out = { ...fields }
  if (detail.date) out.date = detail.date
  if (detail.customer) out.customer = detail.customer
  return out
}

export type ReorganizePreview = {
  mode: "reorganize"
  model: string
  promptVersion: string
  aiConfigured: boolean
  shots: number
  missingTranscripts: number
  transcriptChars: number
  transcriptLines: number
  /** 超长截断提示：转写超过 3 万字只送前 3 万字。 */
  truncated: boolean
  estimate: CostEstimate
  /** 已经跑过的次数（页面上提示「会新增一条历史」）。 */
  previousRuns: number
}

async function schemaOrThrow(): Promise<FeishuTableSchema> {
  const state = await loadFeishuSchemaState()
  if (!state.ok) throw new FeishuSchemaError(state.error)
  return state.schema
}

/** 预览：只读快照和配置，不调模型、不写任何文件。 */
export async function previewReorganize({
  kbDir,
  detail,
  previousRuns = 0,
}: {
  kbDir: string
  detail: ReplayRecordDetail
  previousRuns?: number
}): Promise<ReorganizePreview> {
  const schema = await schemaOrThrow()
  const transcript = await readSnapshotTranscript(kbDir, detail)
  const systemChars = buildExtractSystem(schema, "paste", "short").length + buildExtractSystem(schema, "paste", "long").length
  const prices = await readModelPrices(kbDir)
  const price = priceFor(prices, aiModelName())
  const estimate = estimateReorganizeCost({
    transcriptChars: Math.min(transcript.text.length, MAX_TRANSCRIPT_CHARS),
    systemChars,
    price,
    pricesUpdatedAt: prices.updatedAt,
  })
  return {
    mode: "reorganize",
    model: aiModelName(),
    promptVersion: FIELDS_PROMPT_VERSION,
    aiConfigured: aiConfigured(),
    shots: transcript.shots,
    missingTranscripts: transcript.missingTranscripts,
    transcriptChars: transcript.text.length,
    transcriptLines: transcript.lines,
    truncated: transcript.text.length > MAX_TRANSCRIPT_CHARS,
    estimate,
    previousRuns,
  }
}

/**
 * 执行「只重跑整理」：一次模型调用（内部是短字段/长段落两个并行请求），
 * 结果写进 replay/results/，返回这次运行。
 */
export async function runReorganize({
  kbDir,
  detail,
  at = new Date(),
  runId,
}: {
  kbDir: string
  detail: ReplayRecordDetail
  at?: Date
  runId?: string
}): Promise<ReplayRun> {
  const schema = await schemaOrThrow()
  const transcript = await readSnapshotTranscript(kbDir, detail)
  const chat = transcriptForModel(transcript.text)
  if (!chat) throw new Error("快照里没有可用的转写文字；这条记录可能没有聊天截图，或截图转写失败了")

  const settings = await loadSpeakersSettings(kbDir)
  const me = settings.ok ? settings.settings.myNicknames[0] : undefined

  const t0 = Date.now()
  const { result, usage } = await extractRecordWithUsage(chat, { me, customer: detail.customer || undefined })
  const durationMs = Date.now() - t0

  const prices = await readModelPrices(kbDir)
  const price = priceFor(prices, aiModelName())
  const costYuan = usage ? estimateCost({ promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, price }) : null

  const warnings: string[] = []
  if (result.warning) warnings.push(result.warning)
  if (transcript.missingTranscripts) warnings.push(`有 ${transcript.missingTranscripts} 张截图没有可用转写，已跳过`)
  if (transcript.text.length > MAX_TRANSCRIPT_CHARS) warnings.push("转写超过 3 万字，只送了前 3 万字给模型")
  if (!result.draft.title && !result.draft.problem) warnings.push("模型没有给出标题和问题描述，这次结果基本为空")

  const run: ReplayRun = {
    version: 1,
    runId: runId ?? newRunId(at),
    recordId: detail.recordId,
    r: detail.r,
    mode: "reorganize",
    at: at.toISOString(),
    durationMs,
    model: aiModelName(),
    promptVersion: FIELDS_PROMPT_VERSION,
    extractMode: result.mode,
    usage,
    costYuan,
    transcript: transcript.text,
    fields: fillContextFields(draftToFields(result.draft, schema), detail),
    uncertain: result.draft.uncertain ?? [],
    warning: warnings.length ? warnings.join("；") : undefined,
    review: null,
  }
  await writeRun(kbDir, run)
  return run
}

// ——— 「从截图重新转写」（PR2） ————————————————————————————

/**
 * 预览：这次要重转几张图、大概多少钱。
 * 图片 token 用快照里已有转写的平均用量估，字段部分用当前转写长度估，不调模型。
 */
export type RetranscribePreview = {
  mode: "retranscribe"
  vlModel: string
  model: string
  promptVersion: string
  transcriptPromptVersion: string
  /** 需要重新转写的聊天截图张数。 */
  shots: number
  /** 非聊天截图（报错/界面/效果图），不重转。 */
  skipped: number
  /** 快照里找不到图片文件的张数（会失败，先提示）。 */
  missingMedia: number
  myNicknameCount: number
  companyPrefixCount: number
  estimate: {
    vlPromptTokens: number
    vlCompletionTokens: number
    fieldPromptTokens: number
    fieldCompletionTokens: number
    /** 两段加起来的金额；任一段缺单价时为 null，缺的那段写在 missingPrice。 */
    costYuan: number | null
    missingPrice: string[]
    priceNote: string
  }
  previousRuns: number
}

async function averageSnapshotUsage(kbDir: string, detail: ReplayRecordDetail, limit = 40): Promise<TokenAverage[]> {
  const out: TokenAverage[] = []
  for (const shot of detail.shots.slice(0, limit)) {
    try {
      const json = JSON.parse(await fs.readFile(path.join(snapshotDir(kbDir), shot.transcript), "utf8")) as {
        usage?: { promptTokens?: number; completionTokens?: number }
        ms?: number
      }
      const promptTokens = Number(json?.usage?.promptTokens ?? 0)
      const completionTokens = Number(json?.usage?.completionTokens ?? 0)
      if (promptTokens || completionTokens) {
        out.push({ promptTokens, completionTokens, ms: Number(json?.ms ?? 0) })
      }
    } catch {
      /* 缺转写文件就跳过，平均用量按剩下的算 */
    }
  }
  return out
}

function priceOf(prices: ModelPrices, model: string): ModelPrice {
  return priceFor(prices, model)
}

/** 预览「从截图重新转写」：只读快照和配置。 */
export async function previewRetranscribe({
  kbDir,
  detail,
  previousRuns = 0,
  vlModel,
  transcriptVersion = TRANSCRIPT_PROMPT_VERSION_V3,
}: {
  kbDir: string
  detail: ReplayRecordDetail
  previousRuns?: number
  vlModel: string
  transcriptVersion?: ReplayTranscriptVersion
}): Promise<RetranscribePreview> {
  const schema = await schemaOrThrow()
  const settingsState = await loadSpeakersSettings(kbDir)
  const settings = settingsState.ok ? settingsState.settings : { myNicknames: [], companyPrefixes: [] }
  const chatShots = detail.shots.filter((s) => s.isChat !== false)
  let missingMedia = 0
  for (const shot of chatShots) {
    try {
      await fs.access(path.join(snapshotDir(kbDir), shot.file))
    } catch {
      missingMedia++
    }
  }

  const prices = await readModelPrices(kbDir)
  const vlPrice = priceOf(prices, vlModel)
  const fieldPrice = priceOf(prices, aiModelName())
  const avg = averageUsage(await averageSnapshotUsage(kbDir, detail))
  const vlPromptTokens = Math.round(avg.promptTokens * chatShots.length)
  const vlCompletionTokens = Math.round(avg.completionTokens * chatShots.length)

  const existing = await readSnapshotTranscript(kbDir, detail)
  const systemChars = buildExtractSystem(schema, "paste", "short").length + buildExtractSystem(schema, "paste", "long").length
  const fieldPromptTokens =
    estimateTokens(systemChars) + 2 * estimateTokens(Math.min(existing.text.length || 2000, MAX_TRANSCRIPT_CHARS))
  const fieldCompletionTokens = 1200

  const vlCost = estimateCost({ promptTokens: vlPromptTokens, completionTokens: vlCompletionTokens, price: vlPrice })
  const fieldCost = estimateCost({ promptTokens: fieldPromptTokens, completionTokens: fieldCompletionTokens, price: fieldPrice })
  const missingPrice: string[] = []
  if (vlCost == null) missingPrice.push(`转写模型 ${vlModel || "（未配置 DASHSCOPE_VL_MODEL）"}`)
  if (fieldCost == null) missingPrice.push(`字段模型 ${aiModelName()}`)

  return {
    mode: "retranscribe",
    vlModel,
    model: aiModelName(),
    promptVersion: FIELDS_PROMPT_VERSION,
    transcriptPromptVersion: transcriptVersion,
    shots: chatShots.length,
    skipped: detail.shots.length - chatShots.length,
    missingMedia,
    myNicknameCount: settings.myNicknames.length,
    companyPrefixCount: settings.companyPrefixes.length,
    estimate: {
      vlPromptTokens,
      vlCompletionTokens,
      fieldPromptTokens,
      fieldCompletionTokens,
      costYuan: vlCost == null || fieldCost == null ? null : vlCost + fieldCost,
      missingPrice,
      priceNote: `${prices.updatedAt || "未注明日期"} 的 KB_DIR/config/model-prices.json`,
    },
    previousRuns,
  }
}

/**
 * 执行「从截图重新转写」：
 *  1. 用转写提示词把快照里的聊天截图重新转写（每张一次 VL 调用，按顺序拼接去重叠）。
 *     默认 v3 = v1 原文 + 三条判断侧别的规则；对照实验可传 transcript-v1。
 *  2. 用气泡左右定发言人、昵称交叉核对（`resolveSpeakerTurns`）。
 *  3. 用同一套字段提示词出字段；日期和客户从快照补（这两列本来靠上下文）。
 *  4. 结果写 replay/results/，`transcriptPromptVersion` 记实际用的版本。
 *
 * 只读快照，不写 snapshot/transcripts/（那是快照自己的证据），也不写飞书。
 */
export async function runRetranscribe({
  kbDir,
  detail,
  vlModel,
  dashscopeKey,
  dashscopeBase,
  at = new Date(),
  runId,
  concurrency = 4,
  transcriptVersion = TRANSCRIPT_PROMPT_VERSION_V3,
}: {
  kbDir: string
  detail: ReplayRecordDetail
  vlModel: string
  dashscopeKey: string
  dashscopeBase: string
  at?: Date
  runId?: string
  concurrency?: number
  transcriptVersion?: ReplayTranscriptVersion
}): Promise<ReplayRun> {
  const schema = await schemaOrThrow()
  if (!dashscopeKey || !vlModel) throw new Error("缺少 DASHSCOPE_API_KEY / DASHSCOPE_VL_MODEL，无法重新转写截图")
  const settingsState = await loadSpeakersSettings(kbDir)
  const settings = settingsState.ok ? settingsState.settings : { myNicknames: [], companyPrefixes: [] }
  const prompt = promptFor(transcriptVersion)

  const chatShots = detail.shots.filter((s) => s.isChat !== false)
  if (!chatShots.length) throw new Error("这条记录没有聊天截图，无法从截图重新转写")

  const t0 = Date.now()
  const parts: (TranscriptTurn[] | null)[] = new Array(chatShots.length).fill(null)
  const failures: number[] = []
  let vlPromptTokens = 0
  let vlCompletionTokens = 0
  let windowTitle = ""

  await runPool(
    chatShots.map((shot, index) => ({ shot, index })),
    Math.max(1, Math.min(concurrency, 6)),
    async ({ shot, index }) => {
      try {
        const result = await transcribeImageFile(path.join(snapshotDir(kbDir), shot.file), { dashscopeKey, dashscopeBase, vlModel }, { prompt })
        if (!result.ok) {
          failures.push(index + 1)
          return
        }
        vlPromptTokens += result.usage.promptTokens
        vlCompletionTokens += result.usage.completionTokens
        if (!windowTitle && result.windowTitle) windowTitle = result.windowTitle
        parts[index] = result.turns
      } catch {
        failures.push(index + 1)
      }
    },
  )

  if (failures.length === parts.length) throw new Error(`全部截图重新转写失败（${failures.length} 张），检查通义配置后重试`)

  // 按图片顺序拼（缺图的位置跳过），再去掉相邻截图的重叠。
  const ordered = parts.filter((p): p is TranscriptTurn[] => Array.isArray(p))
  const mergedTurns = dropTitleTurns(mergeTranscriptList(ordered, settings.companyPrefixes), windowTitle)
  const titleNames = namesFromWindowTitle(windowTitle)
  const { chat, uncertain: speakerUncertain, turns: resolvedTurns } = resolveAndFormat(mergedTurns, settings, titleNames)
  const chatForModel = transcriptForModel(chat)

  const { result: fieldsResult, usage: fieldUsage } = await extractRecordWithUsage(chatForModel, {
    me: settings.myNicknames[0],
    customer: detail.customer || undefined,
  })
  const durationMs = Date.now() - t0

  const prices = await readModelPrices(kbDir)
  const vlCost = estimateCost({
    promptTokens: vlPromptTokens,
    completionTokens: vlCompletionTokens,
    price: priceOf(prices, vlModel),
  })
  const fieldCost = fieldUsage
    ? estimateCost({ promptTokens: fieldUsage.promptTokens, completionTokens: fieldUsage.completionTokens, price: priceOf(prices, aiModelName()) })
    : null
  const costYuan = vlCost == null && fieldCost == null ? null : (vlCost ?? 0) + (fieldCost ?? 0)

  const warnings: string[] = []
  if (fieldsResult.warning) warnings.push(fieldsResult.warning)
  if (failures.length) warnings.push(`${failures.length} 张截图重新转写失败，已跳过`)
  if (!settings.myNicknames.length) warnings.push("设置页还没填「我的昵称」，发言人只能按气泡位置判断")
  if (!hasTitle(fieldsResult)) warnings.push("模型没有给出标题和问题描述，这次结果基本为空")

  const run: ReplayRun = {
    version: 1,
    runId: runId ?? newRunId(at),
    recordId: detail.recordId,
    r: detail.r,
    mode: "retranscribe",
    at: at.toISOString(),
    durationMs,
    model: aiModelName(),
    promptVersion: FIELDS_PROMPT_VERSION,
    transcriptPromptVersion: transcriptVersion,
    extractMode: fieldsResult.mode,
    usage: { promptTokens: vlPromptTokens + (fieldUsage?.promptTokens ?? 0), completionTokens: vlCompletionTokens + (fieldUsage?.completionTokens ?? 0) },
    costYuan,
    transcript: chat,
    ...(windowTitle ? { windowTitle } : {}),
    turns: resolvedTurns.map((t, i) => ({
      speaker: t.speaker,
      // 引用合并会减少行数，rawSpeaker 优先用重判时记下的原始名字，不要再按下标取。
      rawSpeaker: t.rawSpeaker ?? mergedTurns[i]?.speaker ?? "",
      text: t.text,
      kind: t.kind === "time" ? "time" : "speech",
      ...(t.side ? { side: t.side } : {}),
    })),
    fields: fillContextFields(draftToFields(fieldsResult.draft, schema), detail),
    uncertain: mergeUncertain(speakerUncertain, fieldsResult.draft.uncertain ?? []),
    warning: warnings.length ? warnings.join("；") : undefined,
    review: null,
  }
  await writeRun(kbDir, run)
  return run
}

function hasTitle(result: { draft: Partial<RecordDraft> }): boolean {
  return Boolean(result.draft.title || result.draft.problem)
}
