import "server-only"
import {
  buildExtractSystem,
  customerFromWindowTitle,
  type FeishuTableSchema,
} from "./feishu-schema"
import { loadFeishuSchemaState } from "./feishu-schema-load"
import { extractRecord } from "./ai"
import {
  VL_TRANSCRIPT_RULE,
  VL_TRANSCRIPT_SCHEMA,
  applyTranscript,
  cleanWindowTitle,
  completedPrefix,
  dropTitleTurns,
  failedScreenshotNote,
  failedScreenshotTurn,
  formatScreenshotChat,
  mergeTranscriptList,
  mergeUncertain,
  parseTranscript,
  type TranscriptTurn,
} from "./transcript"
import { type ExtractErrorCode, type ExtractResult } from "./types"

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY
const DASHSCOPE_BASE_URL = (
  process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"
).replace(/\/$/, "")
const DASHSCOPE_VL_MODEL = process.env.DASHSCOPE_VL_MODEL ?? "qwen3-vl-plus"

/**
 * qwen3-vl-plus 最大输出长度（非思考 / 思考模式均为 32768）。
 * https://help.aliyun.com/zh/model-studio/qwen3-vl-plus 「上下文限制」
 */
export const QWEN3_VL_PLUS_MAX_OUTPUT_TOKENS = 32768

export const TRUNCATED_VL_MESSAGE = "截图太多或聊天太长，输出被截断，请分两批上传"

export function resolveVlMaxTokens(raw = process.env.DASHSCOPE_VL_MAX_TOKENS): number {
  if (raw == null || raw.trim() === "") return QWEN3_VL_PLUS_MAX_OUTPUT_TOKENS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return QWEN3_VL_PLUS_MAX_OUTPUT_TOKENS
  return Math.floor(n)
}

/** Default VL HTTP timeout: 5 minutes. */
export const VL_TIMEOUT_MS_DEFAULT = 5 * 60 * 1000

export function resolveVlTimeoutMs(raw = process.env.DASHSCOPE_VL_TIMEOUT_MS): number {
  if (raw == null || raw.trim() === "") return VL_TIMEOUT_MS_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return VL_TIMEOUT_MS_DEFAULT
  return Math.floor(n)
}

export function vlTimeoutMessage(ms = VL_TIMEOUT_MS_DEFAULT): string {
  const minutes = ms / 60_000
  const wait =
    minutes >= 1 && Number.isInteger(minutes)
      ? `（已等待 ${minutes} 分钟）`
      : minutes >= 1
        ? `（已等待约 ${Math.max(1, Math.round(minutes))} 分钟）`
        : `（已等待 ${Math.max(1, Math.round(ms / 1000))} 秒）`
  return `通义 VL 请求超时${wait}，请改用粘贴文字。截图较多时可分两批上传。`
}

export const MAX_SCREENSHOTS = 9

export function vlConfigured() {
  return Boolean(DASHSCOPE_API_KEY)
}

export function vlLabel() {
  return DASHSCOPE_API_KEY ? DASHSCOPE_VL_MODEL : "未配置通义 VL"
}

export class VlExtractError extends Error {
  code: ExtractErrorCode
  constructor(code: ExtractErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = "VlExtractError"
  }
}

export function errorIfTruncated(finishReason: string | null | undefined): VlExtractError | null {
  if (finishReason === "length") return new VlExtractError("truncated", TRUNCATED_VL_MESSAGE)
  return null
}

export function vlTransportError(e: unknown, timeoutMs = resolveVlTimeoutMs()): VlExtractError {
  const err = e as Error
  const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError" || /aborted|timeout/i.test(err?.message ?? "")
  if (timedOut) return new VlExtractError("timeout", vlTimeoutMessage(timeoutMs))
  return new VlExtractError("parse_error", `通义 VL 网络错误：${err?.message || "未知"}。可改用粘贴文字。`)
}

export function vlSystemFor(schema: FeishuTableSchema): string {
  return `${buildExtractSystem(schema, "screenshot")}\n6. ${VL_TRANSCRIPT_RULE}\n在 JSON 中增加：\n${VL_TRANSCRIPT_SCHEMA}`
}

function mimeOf(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg"
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png"
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif"
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp"
  return "image/jpeg"
}

function nullToEmpty(v: unknown): string {
  if (v === null || v === undefined) return ""
  return String(v)
}

/** Transcript merge used by tests and as the chat half of a VL draft. */
export function normalizeVlDraft(d: Record<string, unknown>, ctx: { me?: string } = {}): {
  chat: string
  uncertain: string[]
  title: string
  problem: string
} {
  const uncertain = Array.isArray(d.uncertain) ? d.uncertain.map((u) => String(u)) : []
  const transcribed = applyTranscript(d.transcript, uncertain, {
    me: ctx.me,
    contact: nullToEmpty(d.contact),
  })
  return {
    title: nullToEmpty(d.title),
    problem: nullToEmpty(d.problem),
    uncertain: transcribed.uncertain,
    chat: transcribed.chat,
  }
}

function mapHttpError(status: number, body: string): VlExtractError {
  if (status === 401 || status === 403) {
    return new VlExtractError("auth", "通义 VL 鉴权失败，请检查 DASHSCOPE_API_KEY")
  }
  if (status === 429) {
    return new VlExtractError("rate_limit", "通义 VL 触发限流，请稍后再试")
  }
  if (status === 400 && /unsafe|content|risk|敏感/i.test(body)) {
    return new VlExtractError("unsafe", "截图内容被安全策略拒绝，请改用粘贴文字")
  }
  return new VlExtractError("parse_error", `通义 VL 接口返回 ${status}: ${body.slice(0, 180)}`)
}

/** Compress image buffer: long edge ≤ maxEdge, JPEG quality, size soft-cap. */
export async function compressImageBuffer(
  input: Buffer,
  opts: { maxEdge?: number; quality?: number; maxBytes?: number } = {},
): Promise<Buffer> {
  const maxEdge = opts.maxEdge ?? 2048
  const quality = opts.quality ?? 82
  const maxBytes = opts.maxBytes ?? 1_500_000
  try {
    const sharp = (await import("sharp")).default
    let img = sharp(input).rotate()
    const meta = await img.metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    if (w > maxEdge || h > maxEdge) {
      img = img.resize({
        width: w >= h ? maxEdge : undefined,
        height: h > w ? maxEdge : undefined,
        fit: "inside",
        withoutEnlargement: true,
      })
    }
    let out = await img.jpeg({ quality, mozjpeg: true }).toBuffer()
    if (out.length > maxBytes) {
      out = await sharp(out)
        .jpeg({ quality: Math.max(55, quality - 20), mozjpeg: true })
        .toBuffer()
    }
    return out
  } catch {
    return input
  }
}

/** Transcribe ONE screenshot; the vision model only outputs the transcript + the window title. */
export async function transcribeImage(
  input: Buffer,
): Promise<{ turns: TranscriptTurn[]; windowTitle: string }> {
  if (!DASHSCOPE_API_KEY) {
    throw new VlExtractError("auth", "未配置 DASHSCOPE_API_KEY，无法从截图提取；请改用粘贴文字")
  }
  const mime = mimeOf(input)
  const prompt = `这是微信或飞书聊天的一张截图。只输出 JSON：{"window_title":"截图顶部的聊天窗口标题，如「示例客户(12) 我方公司技术支持」，看不清就留空","transcript":[{"speaker":"昵称","side":"left|right","kind":"speech|time","text":"原文"}]}。${VL_TRANSCRIPT_RULE} 只转写这一张截图，不要输出客户、问题描述等字段。`
  let res: Response
  try {
    res = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify({
        model: DASHSCOPE_VL_MODEL,
        temperature: 0.2,
        enable_thinking: false,
        max_tokens: resolveVlMaxTokens(),
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:${mime};base64,${input.toString("base64")}` } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(resolveVlTimeoutMs()),
    })
  } catch (e) {
    throw vlTransportError(e)
  }
  const rawText = await res.text()
  if (!res.ok) throw mapHttpError(res.status, rawText)
  let parsedApi: { choices?: Array<{ finish_reason?: string | null; message?: { content?: string } }> }
  try {
    parsedApi = JSON.parse(rawText) as typeof parsedApi
  } catch {
    throw new VlExtractError("parse_error", "通义 VL 返回无法解析，请改用粘贴文字")
  }
  const choice = parsedApi.choices?.[0]
  const truncated = errorIfTruncated(choice?.finish_reason)
  if (truncated) throw truncated
  const text = choice?.message?.content ?? ""
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new VlExtractError("parse_error", "通义 VL 未返回 JSON，请改用粘贴文字")
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    throw new VlExtractError("parse_error", "通义 VL JSON 解析失败，请改用粘贴文字")
  }
  return {
    turns: parseTranscript(obj.transcript),
    windowTitle: cleanWindowTitle(typeof obj.window_title === "string" ? obj.window_title : ""),
  }
}

/** One screenshot's transcription result. */
export type TranscribedPart = { turns: TranscriptTurn[]; windowTitle: string }

export type TranscriptFailure = { index: number; reason: unknown }

/** Progress pushed to the client while the screenshots are still being transcribed. */
export type ScreenshotProgress = {
  /** How many screenshots are done (including failed ones, which keep a placeholder line). */
  done: number
  total: number
  /** The 原始聊天记录 text so far: finished screenshots in image order, overlaps merged. */
  chat: string
  turns: TranscriptTurn[]
  windowTitle: string
}

export type ScreenshotExtractOptions = { customer?: string; me?: string; profile?: string }

/** Merge finished screenshots in image order; the first window title wins. */
export function mergeInOrder(parts: TranscribedPart[]): {
  turns: TranscriptTurn[]
  windowTitle: string
} {
  const windowTitle = parts.map((p) => p.windowTitle).find(Boolean) ?? ""
  const merged = mergeTranscriptList(parts.map((p) => p.turns))
  return { turns: dropTitleTurns(merged, windowTitle), windowTitle }
}

/** Input checks shared by the streaming and the one-shot screenshot paths. */
function assertExtractable(images: Buffer[]): void {
  if (!DASHSCOPE_API_KEY) {
    throw new VlExtractError("auth", "未配置 DASHSCOPE_API_KEY，无法从截图提取；请改用粘贴文字")
  }
  if (images.length === 0) {
    throw new VlExtractError("parse_error", "没有收到截图")
  }
  if (images.length > MAX_SCREENSHOTS) {
    throw new VlExtractError("parse_error", `最多 ${MAX_SCREENSHOTS} 张截图`)
  }
}

/** Screenshots → fields. Shared by the streaming and the one-shot paths. */
async function fieldsFromScreenshots(
  parts: TranscribedPart[],
  failures: TranscriptFailure[],
  total: number,
  opts: ScreenshotExtractOptions,
  schema: FeishuTableSchema,
): Promise<ExtractResult> {
  if (failures.length === total) {
    // Every screenshot failed: keep the old single-error experience (auth/timeout hints + 改用粘贴).
    const reason = failures[0].reason
    if (reason instanceof VlExtractError) throw reason
    throw new VlExtractError("parse_error", `截图转写失败：${(reason as Error)?.message || "未知错误"}。可改用粘贴文字。`)
  }
  const { turns, windowTitle } = mergeInOrder(parts)
  const failureNotes = failures.map((f) => failedScreenshotNote(f.index))
  const chat = formatScreenshotChat(turns)
  const titleHint = windowTitle
    ? `[聊天窗口标题] ${windowTitle}\n（标题形如「客户名(人数) 我方公司技术支持」时：人数前的是客户，紧邻「技术支持」的是我方公司；客户字段优先按标题匹配已有选项，不要把我方公司当客户。）`
    : ""
  const forModel = [chat, titleHint].filter(Boolean).join("\n\n")
  const result = await extractRecord(forModel, opts)
  // Deterministic safety net: the title still decides when the model left the customer blank
  // or picked our own company out of the same title (T18).
  const customerCol = (schema.columns ?? []).find(
    (c) => c.key === "customer" && c.type === "select" && c.extract,
  )
  const customer = customerFromWindowTitle(result.draft.customer ?? "", windowTitle, customerCol)
  return {
    ...result,
    warning: [result.warning, ...failureNotes].filter(Boolean).join("；") || undefined,
    draft: {
      ...result.draft,
      chat,
      ...(customer.value ? { customer: customer.value } : {}),
      uncertain: mergeUncertain(
        mergeUncertain(result.draft.uncertain ?? [], failureNotes),
        customer.uncertain,
      ),
    },
    transcript: turns,
    source: "screenshot",
    imageCount: total,
  }
}

/**
 * Screenshots → fields, calling `onProgress` as soon as each screenshot is transcribed.
 *
 * The screenshots are transcribed in parallel, but the transcript is shown in image order:
 * `onProgress` only reports the longest finished run from the first screenshot, so the text
 * never jumps around when a later screenshot finishes first. Field extraction still needs
 * every transcript and runs at the end.
 */
export async function extractFromScreenshotsStream(
  images: Buffer[],
  opts: ScreenshotExtractOptions,
  onProgress: (progress: ScreenshotProgress) => void,
): Promise<ExtractResult> {
  assertExtractable(images)
  const schemaState = await loadFeishuSchemaState()
  if (!schemaState.ok) throw new VlExtractError("parse_error", schemaState.error)

  const compressed = await Promise.all(images.map((raw) => compressImageBuffer(raw)))
  const slots: (TranscribedPart | null)[] = new Array(compressed.length).fill(null)
  const failures: TranscriptFailure[] = []
  let lastEmitted = ""

  const emit = () => {
    const parts = completedPrefix(slots)
    const done = slots.filter(Boolean).length
    // Nothing to show until the FIRST screenshot is done; later ones wait their turn.
    if (done === 0 || (parts.length === 0 && done < slots.length)) return
    const signature = `${parts.length}/${done}`
    if (signature === lastEmitted) return
    lastEmitted = signature
    const { turns, windowTitle } = mergeInOrder(parts)
    onProgress({
      done,
      total: compressed.length,
      chat: formatScreenshotChat(turns),
      turns,
      windowTitle,
    })
  }

  await Promise.all(
    compressed.map(async (buf, i) => {
      try {
        slots[i] = await transcribeImage(buf)
      } catch (e) {
        failures.push({ index: i + 1, reason: e })
        slots[i] = { turns: [failedScreenshotTurn(i + 1)], windowTitle: "" }
      }
      emit()
    }),
  )

  return fieldsFromScreenshots(slots as TranscribedPart[], failures, compressed.length, opts, schemaState.schema)
}

export async function extractFromScreenshots(
  images: Buffer[],
  opts: ScreenshotExtractOptions,
): Promise<ExtractResult> {
  return extractFromScreenshotsStream(images, opts, () => {})
}
