import type { RecordDraft, TranscriptTurn } from "./types"

/** First line of screenshot-sourced 原始聊天记录. Added by us, not by the model. */
export const OCR_TRANSCRIPT_MARKER = "[OCR 转写，以截图为准]"

export type { TranscriptTurn }

const SPEAKER_KEYS = ["speaker", "发言人", "name", "who", "role"] as const
const TEXT_KEYS = ["text", "内容", "content", "message", "line"] as const

export const VL_TRANSCRIPT_RULE =
  "transcript 是截图中的逐字转写，按上传顺序合并为同一段对话。不要摘要、不要改写、不要补全看不清的字。每一句一条：speaker 用截图上的昵称，看不清昵称就用空字符串；text 保留数字、型号、报错原文。看不清的字用 □，不要猜。不要自己添加「[OCR 转写，以截图为准]」这一行。"

export const VL_TRANSCRIPT_SCHEMA =
  '"transcript": [{"speaker": "昵称或空字符串", "text": "这一句原文"}]'

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
  const full = trimmed.indexOf("：")
  const colonAt = full > 0 ? full : trimmed.indexOf(":")
  if (colonAt > 0) {
    return {
      speaker: trimmed.slice(0, colonAt).trim(),
      text: trimmed.slice(colonAt + 1).trim(),
    }
  }
  return { speaker: "", text: trimmed }
}

function turnsFromText(s: string): TranscriptTurn[] {
  const out: TranscriptTurn[] = []
  for (const line of s.split(/\r?\n/)) {
    const turn = splitSpeakerLine(line)
    if (turn) out.push(turn)
  }
  return out
}

function turnFromObject(item: object): TranscriptTurn | null {
  const o = item as Record<string, unknown>
  if (Array.isArray(o.lines) || Array.isArray(o.items) || Array.isArray(o.transcript)) {
    return null
  }
  const speaker = firstString(o, SPEAKER_KEYS)
  const text = firstString(o, TEXT_KEYS)
  if (!speaker && !text) return null
  if (text.trim() === OCR_TRANSCRIPT_MARKER && !speaker.trim()) return null
  return { speaker, text }
}

/** Accept the VL `transcript` value: turn array, one turn object, or `发言人：内容` lines. */
export function parseTranscript(raw: unknown): TranscriptTurn[] {
  if (raw == null) return []
  if (typeof raw === "string") return turnsFromText(raw)
  if (Array.isArray(raw)) {
    const out: TranscriptTurn[] = []
    for (const item of raw) {
      if (typeof item === "string") out.push(...turnsFromText(item))
      else if (item && typeof item === "object") {
        const o = item as Record<string, unknown>
        if (Array.isArray(o.lines) || Array.isArray(o.items) || Array.isArray(o.transcript)) {
          out.push(...parseTranscript(o.lines ?? o.items ?? o.transcript))
          continue
        }
        const turn = turnFromObject(item)
        if (turn) out.push(turn)
      }
    }
    return out
  }
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>
    if (Array.isArray(o.lines) || Array.isArray(o.items) || Array.isArray(o.transcript)) {
      return parseTranscript(o.lines ?? o.items ?? o.transcript)
    }
    const turn = turnFromObject(raw)
    return turn ? [turn] : []
  }
  return []
}

/** Screenshot 原始聊天记录: fixed first line, then one `发言人：内容` per turn. */
export function formatScreenshotChat(turns: TranscriptTurn[]): string {
  const lines: string[] = []
  for (const t of turns) {
    const text = t.text.replace(/\s*\n\s*/g, " ").trim()
    if (!text || text === OCR_TRANSCRIPT_MARKER) continue
    const speaker = t.speaker.trim() || "未知"
    lines.push(`${speaker}：${text}`)
  }
  return [OCR_TRANSCRIPT_MARKER, ...lines].join("\n")
}

export function transcriptUncertainty(turns: TranscriptTurn[]): string[] {
  const usable = turns.filter((t) => t.text.replace(/\s*\n\s*/g, " ").trim() && t.text.trim() !== OCR_TRANSCRIPT_MARKER)
  const notes: string[] = []
  if (usable.length === 0) notes.push("截图转写为空，请对照截图补全原始聊天记录")
  if (usable.some((t) => !t.speaker.trim())) notes.push("有发言未能识别发言人，已标为「未知」")
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

export function applyTranscript(rawTranscript: unknown, uncertain: string[]): Pick<RecordDraft, "chat" | "uncertain"> {
  const turns = parseTranscript(rawTranscript)
  return {
    chat: formatScreenshotChat(turns),
    uncertain: mergeUncertain(uncertain, transcriptUncertainty(turns)),
  }
}
