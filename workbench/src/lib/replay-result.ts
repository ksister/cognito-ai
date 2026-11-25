import { REORGANIZE_FIELD_LABELS } from "./reorganize.ts"

/**
 * T27 重新识别：一次运行的结果、用户核对、对比和费用估算。
 * 全部是纯函数（不碰磁盘、不碰网络），页面、API 和单测共用。
 *
 * 设计要点（D21 / D22）：
 *  - 结果只存在 KB_DIR/replay/results/<飞书记录 ID>/<runId>.json，不进 records/，不写飞书。
 *  - 每次运行都记：模式、模型、提示词版本、时间、用量、费用。
 *  - 状态规则：用户点「完成核对」的那次运行才算核对过；记录状态取最近一次核对过的运行
 *    （任一字段选了问题类型 = 有问题，否则 = 已测）；更新的运行还没核对时，列表提示「有新结果待核对」。
 *
 * Script-safe: no `server-only`, `.ts` suffix on relative runtime imports.
 */

export type ReplayIssueType = "misread" | "missing" | "fabricated" | "speaker"

/** 问题类型（T27 定的四种，不要随意加）。 */
export const REPLAY_ISSUE_TYPES: ReplayIssueType[] = ["misread", "missing", "fabricated", "speaker"]

export const REPLAY_ISSUE_LABEL: Record<ReplayIssueType, string> = {
  misread: "理解错了",
  missing: "漏了信息",
  fabricated: "编造",
  speaker: "说话人认错",
}

export function isReplayIssueType(v: unknown): v is ReplayIssueType {
  return typeof v === "string" && (REPLAY_ISSUE_TYPES as string[]).includes(v)
}

export type ReplayMode = "reorganize" | "retranscribe"

export const REPLAY_MODE_LABEL: Record<ReplayMode, string> = {
  reorganize: "只重跑整理",
  retranscribe: "从截图重新转写",
}

/** 一个问题字段的建议 + 问题类型（用户手写，AI 不碰）。 */
export type ReplayFieldReview = {
  note: string
  issue: ReplayIssueType | null
}

export type ReplayReview = {
  /** key 是表结构里的字段 key（title/problem/...）。没写过建议的字段不出现。 */
  fields: Record<string, ReplayFieldReview>
  /** 记录级：发言人（谁说的）有误。仅凭这一个勾选也算「有问题」。 */
  speakerError?: boolean
  /** 记录级：错了几条（用户自己数的）。 */
  speakerErrorCount?: number
  /** 用户点「完成核对」的时间；null = 还没核对（草稿建议仍然存着）。 */
  reviewedAt: string | null
  updatedAt: string
}

export type ReplayRun = {
  version: 1
  /** 文件名（不含 .json），同一条记录内唯一、可按时间排序。 */
  runId: string
  recordId: string
  r: string
  mode: ReplayMode
  /** 运行开始时间（ISO）。 */
  at: string
  durationMs: number
  /** 出字段用的文字模型。 */
  model: string
  /** 出字段用的提示词版本（如 fields-v1）。 */
  promptVersion: string
  /** 「从截图重新转写」时，转写提示词版本（transcript-v1 / transcript-v2）。PR1 不写。 */
  transcriptPromptVersion?: string
  extractMode: "ai" | "rules"
  usage: { promptTokens: number; completionTokens: number } | null
  /** 按用量和私有单价算出的费用（元）；单价缺失时 null。 */
  costYuan: number | null
  /** 这次喂给模型的转写原文（带 OCR 标记行，界面上可展开查看）。 */
  transcript: string
  /**
   * 「从截图重新转写」时保存逐条发言人（带气泡左右）：
   * 排查「客户被标成我」时看侧边分布，T29 取「我当时的实际回复」也用得上。
   * `rawSpeaker` 是模型在截图里看到的原始名字（空 = 模型没给名字），用来统计
   * 「右侧但没名字却被判成我」这类错误。
   */
  turns?: {
    speaker: string
    text: string
    kind?: "speech" | "time"
    side?: "left" | "right"
    rawSpeaker?: string
  }[]
  /** 本次提取的字段，已经按表结构转成字符串（多选用 schema 的分隔符）。 */
  fields: Record<string, string>
  uncertain: string[]
  warning?: string
  review: ReplayReview | null
}

// ——— 字段标签与对比 ————————————————————————————————

/** 对比界面用的字段名；表结构里多出来的 key 直接显示 key。 */
export const REPLAY_FIELD_LABELS: Record<string, string> = {
  ...REORGANIZE_FIELD_LABELS,
  date: "创建时间",
  needs: "需求线索",
  local_id: "本地记录ID",
  docs: "相关文档",
  channel: "渠道",
  module: "模块",
  category: "分类",
}

export function replayFieldLabel(key: string): string {
  return REPLAY_FIELD_LABELS[key] ?? key
}

/**
 * 多选字段：飞书单元格是空格拼接，结果是「、」拼接，直接比会全不一样。
 * 与 feishu-schema 的 MULTI_FIELD_KEYS 必须一致（单测里有对比断言，防止两边走散）。
 */
export const REPLAY_MULTI_KEYS = ["dimensions", "inspection_types", "industries"] as const
const MULTI_KEYS = new Set<string>(REPLAY_MULTI_KEYS)

export function splitMultiValue(value: string): string[] {
  return String(value ?? "")
    .split(/[\s、，,;；/／|]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 比较用的归一化：只抹掉「排版本」的差异（空白、多选的拼接符、顺序），
 * 不抹掉真正的内容差异。显示仍然用原文。
 */
export function normalizeForCompare(key: string, value: string): string {
  const raw = String(value ?? "").replace(/\u3000/g, " ").trim()
  if (!raw) return ""
  if (MULTI_KEYS.has(key)) {
    const set = [...new Set(splitMultiValue(raw))]
    set.sort((a, b) => a.localeCompare(b, "zh"))
    return set.join("|")
  }
  // 换行、空格不构成差异（同一段话的排版不同不算改）。
  return raw.replace(/\s+/g, "")
}

export type ReplayFieldDiff = {
  key: string
  label: string
  /** 飞书原记录（左）。 */
  left: string
  /** 本次结果（右）。 */
  right: string
  same: boolean
}

/**
 * 左右对比：按 keys 的顺序，标出哪些字段不同。
 * keys 由调用方给（表结构列序），保证界面顺序稳定。
 */
export function compareReplayFields(left: Record<string, string>, right: Record<string, string>, keys: string[]): ReplayFieldDiff[] {
  return keys.map((key) => {
    const a = left[key] ?? ""
    const b = right[key] ?? ""
    return {
      key,
      label: replayFieldLabel(key),
      left: a,
      right: b,
      same: normalizeForCompare(key, a) === normalizeForCompare(key, b),
    }
  })
}

export function countDiffs(rows: ReplayFieldDiff[]): number {
  return rows.filter((r) => !r.same).length
}

// ——— 运行历史与状态 ————————————————————————————————

/** 运行时间（毫秒）；坏数据排到最后。 */
export function runTime(run: Pick<ReplayRun, "at" | "runId">): number {
  const t = Date.parse(String(run.at ?? ""))
  return Number.isNaN(t) ? 0 : t
}

/** 新的在前；时间相同按 runId 排，保证顺序稳定。 */
export function sortRunsNewestFirst<T extends Pick<ReplayRun, "at" | "runId">>(runs: T[]): T[] {
  return [...runs].sort((a, b) => runTime(b) - runTime(a) || String(b.runId).localeCompare(String(a.runId)))
}

export function latestRun<T extends Pick<ReplayRun, "at" | "runId">>(runs: T[]): T | null {
  return sortRunsNewestFirst(runs)[0] ?? null
}

export function isReviewed(run: Pick<ReplayRun, "review">): boolean {
  return Boolean(run.review?.reviewedAt)
}

/** 任一个字段选了问题类型，或记录级的「发言人有误」被勾上 = 这次核对有问题。 */
export function reviewHasIssue(review: ReplayReview | null | undefined): boolean {
  if (!review) return false
  if (review.speakerError) return true
  return Object.values(review.fields ?? {}).some((f) => isReplayIssueType(f?.issue))
}

/** 建议和问题类型都为空 = 这个字段没写过东西，存盘时删掉。 */
export function isBlankFieldReview(f: ReplayFieldReview | null | undefined): boolean {
  return !String(f?.note ?? "").trim() && !isReplayIssueType(f?.issue)
}

export type ReplayRunState = {
  status: "untested" | "tested" | "issue"
  latestRunId: string | null
  /** 最近一次核对过的运行。 */
  reviewedRunId: string | null
  /** 有比「最近一次核对过的运行」更新的运行还没核对（列表上的「有新结果待核对」）。 */
  pendingReview: boolean
}

export function lastReviewedRun<T extends Pick<ReplayRun, "at" | "runId" | "review">>(runs: T[]): T | null {
  return sortRunsNewestFirst(runs.filter((r) => isReviewed(r)))[0] ?? null
}

/**
 * 记录状态（T27 口径，替代 T26 的「跑过就算已测」）：
 *  - 一次都没跑过 → 未测
 *  - 跑过但没点「完成核对」→ 未测（可能同时「有新结果待核对」）
 *  - 取最近一次核对过的运行：有问题类型 → 有问题；没有 → 已测
 */
export function deriveRunState(runs: Pick<ReplayRun, "at" | "runId" | "review">[]): ReplayRunState {
  const latest = latestRun(runs)
  const reviewed = lastReviewedRun(runs)
  if (!reviewed) {
    return {
      status: "untested",
      latestRunId: latest?.runId ?? null,
      reviewedRunId: null,
      pendingReview: Boolean(latest),
    }
  }
  return {
    status: reviewHasIssue(reviewed.review) ? "issue" : "tested",
    latestRunId: latest?.runId ?? null,
    reviewedRunId: reviewed.runId,
    pendingReview: Boolean(latest && latest.runId !== reviewed.runId && runTime(latest) >= runTime(reviewed)),
  }
}

/** 运行历史的显示文案：时间 · 模式 · 模型 · 提示词版本。 */
export function runLabel(run: Pick<ReplayRun, "at" | "mode" | "model" | "promptVersion" | "transcriptPromptVersion" | "review">): string {
  const d = new Date(run.at)
  const pad = (n: number) => String(n).padStart(2, "0")
  const when = Number.isNaN(d.getTime())
    ? run.at
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const prompts = [run.promptVersion, run.transcriptPromptVersion].filter(Boolean).join(" + ")
  const reviewed = run.review?.reviewedAt ? " · 已核对" : ""
  return `${when} · ${REPLAY_MODE_LABEL[run.mode] ?? run.mode} · ${run.model} · ${prompts}${reviewed}`
}

/** 下拉里的大白话：`11-24 17:51 · 重新看图转写（第 2 次）`。ordinal 从 1 开始（最早的算第 1 次）。 */
export function friendlyRunLabel(
  run: Pick<ReplayRun, "at" | "mode">,
  ordinal: number,
  modeLabel?: string,
): string {
  const d = new Date(run.at)
  const pad = (n: number) => String(n).padStart(2, "0")
  const when = Number.isNaN(d.getTime()) ? run.at : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const mode = run.mode === "retranscribe" ? "重新看图转写" : (modeLabel ?? REPLAY_MODE_LABEL[run.mode] ?? run.mode)
  return `${when} · ${mode}（第 ${Math.max(1, ordinal)} 次）`
}

/** 悬停提示：模型、提示词版本、耗时、费用、核对状态。 */
export function runTooltip(
  run: Pick<ReplayRun, "model" | "promptVersion" | "transcriptPromptVersion" | "durationMs" | "costYuan" | "review" | "extractMode">,
): string {
  const prompts = [run.promptVersion, run.transcriptPromptVersion].filter(Boolean).join(" + ")
  const parts = [
    `模型 ${run.model || "未知"}`,
    `提示词 ${prompts || "未知"}`,
    run.extractMode === "rules" ? "规则提取（没配 AI key）" : "",
    run.durationMs ? `${(run.durationMs / 1000).toFixed(1)} 秒` : "",
    run.costYuan != null ? `约 ${run.costYuan.toFixed(4)} 元` : "",
    run.review?.reviewedAt ? "已核对" : "未核对",
  ].filter(Boolean)
  return parts.join(" · ")
}

/** 运行 ID：20261124T090512-ab12（按时间可排序，同一条记录内唯一）。 */
export function newRunId(at: Date = new Date(), suffix?: string): string {
  const iso = at.toISOString()
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
  const rand = (suffix ?? Math.random().toString(16).slice(2, 6)).replace(/[^0-9a-z]/gi, "").slice(0, 4).padEnd(4, "0")
  return `${stamp}-${rand}`
}

export function isValidRunId(id: unknown): id is string {
  return typeof id === "string" && /^\d{8}T\d{6}-[0-9a-z]{4}$/.test(id)
}

/** 飞书记录 ID 只允许这些字符（拼目录名用，挡住路径穿越）。 */
export function isSafeRecordId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{4,80}$/.test(id)
}

// ——— 结果文件的读取与校验（存盘/读盘的边界都走这里） ——————————

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/**
 * 把用户提交的建议清洗成可存的结构：
 *  - 只留字符串建议和四种问题类型；
 *  - 建议和问题类型都空的字段直接丢掉（不占空间，也不会被当成「写过」）。
 */
export function normalizeReviewFields(input: unknown): Record<string, ReplayFieldReview> {
  const out: Record<string, ReplayFieldReview> = {}
  if (!input || typeof input !== "object" || Array.isArray(input)) return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(key)) continue
    const raw = (value ?? {}) as Record<string, unknown>
    const note = String(raw.note ?? "").trim()
    const issue = isReplayIssueType(raw.issue) ? raw.issue : null
    if (isBlankFieldReview({ note, issue })) continue
    out[key] = { note, issue }
  }
  return out
}

/** 读盘时校验一个结果文件；不认识的结构返回 null（页面跳过这个文件，不让整页挂掉）。 */
export function parseReplayRun(value: unknown): ReplayRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const o = value as Record<string, unknown>
  if (o.version !== 1) return null
  if (!isValidRunId(o.runId)) return null
  if (!isSafeRecordId(o.recordId)) return null
  const mode = o.mode === "retranscribe" ? "retranscribe" : o.mode === "reorganize" ? "reorganize" : null
  if (!mode) return null
  if (!str(o.at)) return null
  const fields: Record<string, string> = {}
  if (o.fields && typeof o.fields === "object" && !Array.isArray(o.fields)) {
    for (const [k, v] of Object.entries(o.fields as Record<string, unknown>)) {
      if (/^[A-Za-z0-9_]{1,40}$/.test(k)) fields[k] = String(v ?? "")
    }
  }
  const usageRaw = o.usage as Record<string, unknown> | null | undefined
  const usage =
    usageRaw && typeof usageRaw === "object"
      ? {
          promptTokens: Number(usageRaw.promptTokens ?? 0) || 0,
          completionTokens: Number(usageRaw.completionTokens ?? 0) || 0,
        }
      : null
  const reviewRaw = o.review as Record<string, unknown> | null | undefined
  let review: ReplayReview | null = null
  if (reviewRaw && typeof reviewRaw === "object") {
    const speakerErrorCount = Number(reviewRaw.speakerErrorCount)
    review = {
      fields: normalizeReviewFields(reviewRaw.fields),
      ...(reviewRaw.speakerError === true ? { speakerError: true } : {}),
      ...(Number.isFinite(speakerErrorCount) && speakerErrorCount > 0
        ? { speakerErrorCount: Math.min(9999, Math.round(speakerErrorCount)) }
        : {}),
      reviewedAt: str(reviewRaw.reviewedAt) || null,
      updatedAt: str(reviewRaw.updatedAt) || "",
    }
  }
  const turnsRaw = o.turns
  const turns = Array.isArray(turnsRaw)
    ? turnsRaw
        .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object" && !Array.isArray(t))
        .map((t) => {
          const kind = t.kind === "time" ? ("time" as const) : ("speech" as const)
          const side = t.side === "left" || t.side === "right" ? (t.side as "left" | "right") : undefined
          const rawSpeaker = typeof t.rawSpeaker === "string" ? t.rawSpeaker : undefined
          return {
            speaker: str(t.speaker),
            text: str(t.text),
            kind,
            ...(side ? { side } : {}),
            ...(rawSpeaker !== undefined ? { rawSpeaker } : {}),
          }
        })
    : undefined
  return {
    version: 1,
    runId: o.runId,
    recordId: o.recordId,
    r: str(o.r),
    mode,
    at: str(o.at),
    durationMs: Number(o.durationMs ?? 0) || 0,
    model: str(o.model),
    promptVersion: str(o.promptVersion),
    transcriptPromptVersion: str(o.transcriptPromptVersion) || undefined,
    extractMode: o.extractMode === "rules" ? "rules" : "ai",
    usage,
    costYuan: typeof o.costYuan === "number" ? o.costYuan : null,
    transcript: str(o.transcript),
    ...(turns && turns.length ? { turns } : {}),
    fields,
    uncertain: Array.isArray(o.uncertain) ? o.uncertain.map(String) : [],
    warning: str(o.warning) || undefined,
    review,
  }
}

// ——— 费用估算（调用前先给用户看） ————————————————————

/**
 * 只重跑整理：两次并行请求（短字段 + 长段落），输入 = 两份系统提示词 + 两遍转写，
 * 输出按长短段落合计估。
 * token 估算按「1.2 个汉字 ≈ 1 token」保守折算，宁可多报一点，不报少。
 */
export const ESTIMATE_CHARS_PER_TOKEN = 1.2
export const ESTIMATE_COMPLETION_TOKENS = 1200

export type CostEstimate = {
  promptTokens: number
  completionTokens: number
  costYuan: number | null
  /** 单价来源说明（给用户看的）。 */
  priceNote: string
}

export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / ESTIMATE_CHARS_PER_TOKEN)
}

export function estimateReorganizeCost({
  transcriptChars,
  systemChars,
  price,
  pricesUpdatedAt,
}: {
  transcriptChars: number
  systemChars: number
  price: { input: number | null; output: number | null; priced: boolean } | null
  pricesUpdatedAt?: string
}): CostEstimate {
  const promptTokens = estimateTokens(systemChars) + 2 * estimateTokens(transcriptChars)
  const completionTokens = ESTIMATE_COMPLETION_TOKENS
  const costYuan = price?.priced
    ? (promptTokens / 1_000_000) * (price.input ?? 0) + (completionTokens / 1_000_000) * (price.output ?? 0)
    : null
  const priceNote = price?.priced
    ? `${pricesUpdatedAt || "未注明日期"} 的 KB_DIR/config/model-prices.json`
    : "model-prices.json 里没有这个模型的单价，需要用户核实后才能估算金额"
  return { promptTokens, completionTokens, costYuan, priceNote }
}
