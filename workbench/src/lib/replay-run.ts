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
import { estimateCost, priceFor, readModelPrices } from "./model-prices"
import { loadReplaySettings } from "./replay-config"
import {
  estimateReorganizeCost,
  newRunId,
  type CostEstimate,
  type ReplayRun,
} from "./replay-result"
import { snapshotDir } from "./replay-store"
import { writeRun } from "./replay-results-store"
import type { ReplayRecordDetail } from "./replay-model"
import { formatScreenshotChat, mergeTranscriptList, OCR_TRANSCRIPT_MARKER, type TranscriptTurn } from "./transcript"
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
  const merged = mergeTranscriptList(parts)
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

  const settings = await loadReplaySettings(kbDir)
  const me = settings.ok ? settings.settings.myNicknames[0] : undefined

  const t0 = Date.now()
  const { result, usage } = await extractRecordWithUsage(chat, { me })
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
    fields: draftToFields(result.draft, schema),
    uncertain: result.draft.uncertain ?? [],
    warning: warnings.length ? warnings.join("；") : undefined,
    review: null,
  }
  await writeRun(kbDir, run)
  return run
}
