import type { RecordDraft, TranscriptTurn } from "./types"

/** First line of screenshot-sourced 原始聊天记录. Added by us, not by the model. */
export const OCR_TRANSCRIPT_MARKER = "[OCR 转写，以截图为准]"

export type { TranscriptTurn }

const SPEAKER_KEYS = ["speaker", "发言人", "name", "who", "role"] as const
const TEXT_KEYS = ["text", "内容", "content", "message", "line"] as const

export const VL_TRANSCRIPT_RULE =
  "transcript 是截图中的逐字转写，按上传顺序合并为同一段对话，并且必须是 JSON 的最后一个字段。不要摘要、不要改写、不要补全看不清的字。每一句一条。text 保留数字、型号、报错原文。看不清的字用 □，不要猜。不要自己添加「[OCR 转写，以截图为准]」这一行。截图不显示昵称时按气泡位置判断：右侧 speaker 用调用方给出的本人昵称，没有则写「我」，side 填 right；左侧 speaker 用 contact，没有则写「客户」，side 填 left。时间分隔不要带 speaker，kind 填 time，text 写成单独一行「—— 10月28日 09:12 ——」。图片的 text 写「[图片]」，文件写「[文件] 文件名」，语音写「[语音]」，speaker 仍是发出该条的人。"

export const VL_TRANSCRIPT_SCHEMA =
  '"transcript": [{"speaker": "昵称；无昵称时右侧写我、左侧写客户", "side": "left|right|空", "kind": "speech|time", "text": "原文，或 —— 10月28日 09:12 ——，或 [图片] / [文件] 文件名 / [语音]"}]'

export type SpeakerContext = {
  me?: string
  contact?: string
}

const TIME_LINE = /^(?:——|--)\s*(.+?)\s*(?:——|--)$/

export function isTimeSeparatorLine(text: string): boolean {
  return TIME_LINE.test(text.trim())
}

/** Normalize a time separator to `—— 10月28日 09:12 ——`. */
export function formatTimeSeparator(text: string): string {
  const trimmed = text.replace(/\s*\n\s*/g, " ").trim()
  const matched = trimmed.match(TIME_LINE)
  const inner = (matched ? matched[1] : trimmed).trim()
  return `—— ${inner} ——`
}

export function inferSpeakerFromSide(side: string, ctx: SpeakerContext = {}): string | null {
  const s = side.trim().toLowerCase()
  if (s === "right" || s === "右" || s === "me" || s === "self") return ctx.me?.trim() || "我"
  if (s === "left" || s === "左" || s === "customer") return ctx.contact?.trim() || "客户"
  return null
}

function firstString(o: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === "string") return v
    if (typeof v === "number" && Number.isFinite(v)) return String(v)
  }
  return ""
}

function splitSpeakerLine(line: string): TranscriptTurn | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed === OCR_TRANSCRIPT_MARKER) return null
  if (isTimeSeparatorLine(trimmed)) return { speaker: "", text: formatTimeSeparator(trimmed), kind: "time" }
  const full = trimmed.indexOf("：")
  const colonAt = full > 0 ? full : trimmed.indexOf(":")
  if (colonAt > 0) {
    return {
      speaker: trimmed.slice(0, colonAt).trim(),
      text: trimmed.slice(colonAt + 1).trim(),
      kind: "speech",
    }
  }
  return { speaker: "", text: trimmed, kind: "speech" }
}

function turnsFromText(s: string): TranscriptTurn[] {
  const out: TranscriptTurn[] = []
  for (const line of s.split(/\r?\n/)) {
    const turn = splitSpeakerLine(line)
    if (turn) out.push(turn)
  }
  return out
}

function turnFromObject(item: object, ctx: SpeakerContext): TranscriptTurn | null {
  const o = item as Record<string, unknown>
  if (Array.isArray(o.lines) || Array.isArray(o.items) || Array.isArray(o.transcript)) {
    return null
  }
  const text = firstString(o, TEXT_KEYS)
  const kindRaw = firstString(o, ["kind", "type", "类型"]).toLowerCase()
  const side = firstString(o, ["side", "位置", "bubble"])
  if (kindRaw === "time" || kindRaw === "separator" || kindRaw === "时间" || isTimeSeparatorLine(text)) {
    if (!text.trim()) return null
    return { speaker: "", text: formatTimeSeparator(text), kind: "time" }
  }
  let speaker = firstString(o, SPEAKER_KEYS)
  if (!speaker.trim()) speaker = inferSpeakerFromSide(side, ctx) ?? ""
  if (!speaker && !text) return null
  if (text.trim() === OCR_TRANSCRIPT_MARKER && !speaker.trim()) return null
  return { speaker, text, kind: "speech" }
}

/** Accept the VL `transcript` value: turn array, one turn object, or `发言人：内容` lines. */
export function parseTranscript(raw: unknown, ctx: SpeakerContext = {}): TranscriptTurn[] {
  if (raw == null) return []
  if (typeof raw === "string") return turnsFromText(raw)
  if (Array.isArray(raw)) {
    const out: TranscriptTurn[] = []
    for (const item of raw) {
      if (typeof item === "string") out.push(...turnsFromText(item))
      else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>
        if (Array.isArray(o.lines) || Array.isArray(o.items) || Array.isArray(o.transcript)) {
          out.push(...parseTranscript(o.lines ?? o.items ?? o.transcript, ctx))
          continue
        }
        const turn = turnFromObject(item, ctx)
        if (turn) out.push(turn)
      }
    }
    return out
  }
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>
    if (Array.isArray(o.lines) || Array.isArray(o.items) || Array.isArray(o.transcript)) {
      return parseTranscript(o.lines ?? o.items ?? o.transcript, ctx)
    }
    const turn = turnFromObject(raw, ctx)
    return turn ? [turn] : []
  }
  return []
}

function isTimeTurn(t: TranscriptTurn): boolean {
  return t.kind === "time" || isTimeSeparatorLine(t.text)
}

/** Screenshot 原始聊天记录: fixed first line, then speech or a standalone time line. */
export function formatScreenshotChat(turns: TranscriptTurn[]): string {
  const lines: string[] = []
  for (const t of turns) {
    const text = t.text.replace(/\s*\n\s*/g, " ").trim()
    if (!text || text === OCR_TRANSCRIPT_MARKER) continue
    if (isTimeTurn(t)) {
      lines.push(formatTimeSeparator(text))
      continue
    }
    const speaker = t.speaker.trim() || "未知"
    lines.push(`${speaker}：${text}`)
  }
  return [OCR_TRANSCRIPT_MARKER, ...lines].join("\n")
}

export function transcriptUncertainty(turns: TranscriptTurn[]): string[] {
  const usable = turns.filter((t) => t.text.replace(/\s*\n\s*/g, " ").trim() && t.text.trim() !== OCR_TRANSCRIPT_MARKER)
  const notes: string[] = []
  if (usable.length === 0) notes.push("截图转写为空，请对照截图补全原始聊天记录")
  if (usable.some((t) => !isTimeTurn(t) && !t.speaker.trim())) notes.push("有发言未能识别发言人，已标为「未知」")
  return notes
}

export function mergeUncertain(existing: string[], extra: string[]): string[] {
  const out = [...existing]
  for (const n of extra) {
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

/**
 * Screenshot extract replaces 原始聊天记录 with the formatted transcript.
 * Paste extract keeps whatever the user pasted.
 */
export function resolveExtractedChat(
  source: "screenshot" | "paste" | undefined,
  existingChat: string,
  extractedChat: string | undefined,
): string {
  if (source === "screenshot" && typeof extractedChat === "string") return extractedChat
  return existingChat
}

export function applyTranscript(
  rawTranscript: unknown,
  uncertain: string[],
  ctx: SpeakerContext = {},
): Pick<RecordDraft, "chat" | "uncertain"> {
  const turns = parseTranscript(rawTranscript, ctx)
  return {
    chat: formatScreenshotChat(turns),
    uncertain: mergeUncertain(uncertain, transcriptUncertainty(turns)),
  }
}
