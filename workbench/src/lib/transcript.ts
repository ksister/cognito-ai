import type { RecordDraft, TranscriptTurn } from "./types"

/** First line of screenshot-sourced 原始聊天记录. Added by us, not by the model. */
export const OCR_TRANSCRIPT_MARKER = "[OCR 转写，以截图为准]"

export type { TranscriptTurn }

const SPEAKER_KEYS = ["speaker", "发言人", "name", "who", "role"] as const
const TEXT_KEYS = ["text", "内容", "content", "message", "line"] as const

/** 转写要求里跟发言人无关的部分（v1 / v2 共用）。 */
const TRANSCRIPT_STYLE_RULE =
  "transcript 是截图中的逐字转写，按上传顺序合并为同一段对话，并且必须是 JSON 的最后一个字段。不要摘要、不要改写、不要补全看不清的字。每一句一条。text 保留数字、型号、报错原文。识别不出的字不要写出来、不要猜，绝对不要输出 □、� 或其它乱码；整行都看不清就不输出这一行。所有表情和贴纸一律写成「[表情]」，不要输出 emoji 字符。不要自己添加「[OCR 转写，以截图为准]」这一行。"

/** v1 的发言人规则（主流程和已有快照都用它，**不要改这段**，改了就是换提示词版本）。 */
const TRANSCRIPT_SPEAKER_RULE_V1 =
  "截图不显示昵称时按气泡位置判断：右侧 speaker 用调用方给出的本人昵称，没有则写「我」，side 填 right；左侧 speaker 用 contact，没有则写「客户」，side 填 left。"

/** v2 的发言人规则：只记录气泡位置和截图上显示的昵称，由代码决定谁是「我」。 */
const TRANSCRIPT_SPEAKER_RULE_V2 =
  "每条消息都要给出 side：气泡在右侧填 right（用户本人），在左侧填 left（对方）。speaker 填截图上显示的昵称原文（包含公司前缀就照抄），看不清就留空，绝对不要自己写「我」「客户」，也不要改写或补全昵称。"

/** 时间分隔、图片、文件、语音的写法（v1 / v2 共用）。 */
const TRANSCRIPT_FORMAT_RULE =
  "时间分隔不要带 speaker，kind 填 time，text 写成单独一行「—— 10月28日 09:12 ——」。图片的 text 写「[图片]」，文件写「[文件] 文件名」，语音写「[语音]」，speaker 仍是发出该条的人。"

/** 主流程（截图提取）用的转写规则 = v1。 */
export const VL_TRANSCRIPT_RULE = `${TRANSCRIPT_STYLE_RULE}${TRANSCRIPT_SPEAKER_RULE_V1}${TRANSCRIPT_FORMAT_RULE}`

/** 回放「从截图重新转写」用的 v2 规则（第一批 20 条比对后由技术总监决定是否切换）。 */
export const VL_TRANSCRIPT_RULE_V2 = `${TRANSCRIPT_STYLE_RULE}${TRANSCRIPT_SPEAKER_RULE_V2}${TRANSCRIPT_FORMAT_RULE}`

/**
 * v3 = v1 原文一字不改，只在「怎么判断谁是右侧」那句后面插入「怎么判断 side」的规则（11-25 用户定）。
 * 起因：R153 是钉钉截图，客户连发的消息只有第一条带头像、后面缩进，模型按「离边的距离」判成了右侧。
 * 规则：① 看头像在哪边；② 看气泡颜色；③ 连续没有头像的消息算上一个发送者的。
 *
 * 注意插入位置：必须紧跟在 v1 的「按气泡位置判断」那句后面。第一版把规则追加在整段末尾，
 * 模型仍然按前面那句「按气泡位置判断」把缩进的消息判成右侧（R153 三次里两次右侧 2 条）。
 */
export const TRANSCRIPT_SIDE_RULE_V3 =
  "判断 side 时按这三条，不要按气泡离屏幕边缘的距离、也不要把往内缩进当成右侧：" +
  "① 看头像是谁的：头像在哪一边就属于哪一边（钉钉、飞书里同一个人连发的消息，只有第一条带头像，后面几条往里缩进，缩进不代表换人）。" +
  "② 看气泡颜色：自己发的消息是彩色气泡（钉钉、飞书是蓝色，微信是绿色），对方是白色或灰色。" +
  "③ 连续几条没有头像的消息，算上一个发送者的，除非气泡颜色变了。"

/** 回放「从截图重新转写」用的 v3 规则 = v1 + 紧跟其后的侧别规则（v1 每一句都没改）。 */
export const VL_TRANSCRIPT_RULE_V3 = `${TRANSCRIPT_STYLE_RULE}${TRANSCRIPT_SPEAKER_RULE_V1}${TRANSCRIPT_SIDE_RULE_V3}${TRANSCRIPT_FORMAT_RULE}`

export const VL_TRANSCRIPT_SCHEMA =
  '"transcript": [{"speaker": "昵称；无昵称时右侧写我、左侧写客户", "side": "left|right|空", "kind": "speech|time", "text": "原文，或 —— 10月28日 09:12 ——，或 [图片] / [文件] 文件名 / [语音]"}]'

export type SpeakerContext = {
  me?: string
  contact?: string
  /** 我方公司名前缀（私有配置 speakers.json）；只用于匹配，不改转写原文。 */
  prefixes?: string[]
}

const EMOJI_PIECE = String.raw`(?:\p{Emoji_Presentation}(?:\uFE0F|\p{Emoji_Modifier})?|\p{Extended_Pictographic}\uFE0F)`
/** One visual emoji: emoji-presentation char, VS16 sequence, ZWJ family, skin tone, flag or keycap. */
const EMOJI_RUN = new RegExp(
  String.raw`(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|${EMOJI_PIECE}(?:\u200D${EMOJI_PIECE})*)`,
  "gu",
)

/** Tofu/garbled glyphs the VL model sometimes emits for characters it cannot read. */
const GARBLED = /[\uFFFD\u25A1\u25A2\u25AF\u2B1B\u2B1C]/g

export const EMOJI_PLACEHOLDER = "[表情]"

/**
 * Transcript text cleanup (T18): emoji become 「[表情]」, unreadable glyphs are dropped instead of
 * saved as 「□」/「�」. Only display/save text is touched; speaker names stay as evidence.
 */
export function normalizeTranscriptText(input: string): string {
  if (!input) return ""
  let s = input.replace(EMOJI_RUN, EMOJI_PLACEHOLDER)
  s = s.replace(GARBLED, "")
  s = s.replace(/[\u200B-\u200D\uFE0F]/g, "")
  return s.replace(/[ \t]{2,}/g, " ").trim()
}

/**
 * Clean the window title the VL model read from the top of a chat screenshot.
 * Drops the clock/status prefix and trailing ellipsis; the title is a customer clue, never a message.
 */
export function cleanWindowTitle(raw: string): string {
  let s = String(raw ?? "")
    .split(/\r?\n/)[0]
    .normalize("NFKC")
    .trim()
  s = s.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, "")
  s = s.replace(/^[^\p{L}\p{N}]+/u, "")
  s = s.replace(/\s*[.…]+$/, "")
  s = s.replace(GARBLED, "").replace(/[\u200B-\u200D\uFE0F]/g, "")
  s = s.replace(/\s{2,}/g, " ").trim()
  return s.slice(0, 80)
}

function titleKey(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[（(]\s*\d{1,3}\s*[)）]/g, "")
    .replace(/[\s\u3000·・.,，、;；:：\-—_|/\\()（）\[\]【】"'“”‘’]/g, "")
    .toLowerCase()
}

/** Drop a transcript line that is just the window title copied as a message (T18). */
export function dropTitleTurns(turns: TranscriptTurn[], windowTitle: string): TranscriptTurn[] {
  const title = titleKey(cleanWindowTitle(windowTitle))
  if (!title) return [...turns]
  return turns.filter((turn) => titleKey(turn.text) !== title)
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
  const sideRaw = firstString(o, ["side", "位置", "bubble"]).trim().toLowerCase()
  const side: "left" | "right" | undefined =
    sideRaw === "right" || sideRaw === "右" || sideRaw === "me" || sideRaw === "self"
      ? "right"
      : sideRaw === "left" || sideRaw === "左" || sideRaw === "customer"
        ? "left"
        : undefined
  if (kindRaw === "time" || kindRaw === "separator" || kindRaw === "时间" || isTimeSeparatorLine(text)) {
    if (!text.trim()) return null
    return { speaker: "", text: formatTimeSeparator(text), kind: "time" }
  }
  let speaker = firstString(o, SPEAKER_KEYS)
  if (!speaker.trim()) speaker = inferSpeakerFromSide(sideRaw, ctx) ?? ""
  if (!speaker && !text) return null
  if (text.trim() === OCR_TRANSCRIPT_MARKER && !speaker.trim()) return null
  return { speaker, text, kind: "speech", ...(side ? { side } : {}) }
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
    const text = normalizeTranscriptText(t.text.replace(/\s*\n\s*/g, " "))
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

/** Uncertain note for one screenshot whose transcription failed (one bad image must not waste the batch). */
export function failedScreenshotNote(index: number): string {
  return `第 ${index} 张截图转写失败，可重新整理或改用粘贴`
}

/** Placeholder line kept in 原始聊天记录 where the failed screenshot would have been. */
export function failedScreenshotTurn(index: number): TranscriptTurn {
  return { speaker: "系统", text: failedScreenshotNote(index), kind: "speech" }
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
  const merged = mergeTranscriptList([turns], ctx.prefixes)
  return {
    chat: formatScreenshotChat(merged),
    uncertain: mergeUncertain(uncertain, transcriptUncertainty(merged)),
  }
}

/**
 * Strip emoji and company prefixes from a speaker name for MATCHING ONLY.
 * The raw transcript keeps the original name (it is evidence); never use this to rewrite it.
 * Company prefixes come from the private settings (speakers.json), not from code.
 */
export function normalizeSpeakerName(name: string, prefixes: string[] = []): string {
  let s = name.normalize("NFKC")
  s = s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
  s = s.replace(/\s+/g, " ").trim()
  for (const prefix of prefixes) {
    const p = String(prefix ?? "").trim()
    if (!p) continue
    if (s.startsWith(`${p}_`) || s.startsWith(`${p} `) || s.startsWith(`${p}-`) || s.startsWith(`${p}|`)) {
      const rest = s.slice(p.length).replace(/^[_\s\-|]+/, "").trim()
      if (rest) s = rest
    }
  }
  return s
}

function turnKey(t: TranscriptTurn, prefixes: string[] = []): string {
  return `${normalizeSpeakerName(t.speaker, prefixes)}|${normalizeTranscriptText(t.text).replace(/\s+/g, " ").trim()}`
}

/**
 * Concatenate per-image transcripts, dropping the messages that appear at the bottom of
 * one screenshot and again at the top of the next. Pure: same inputs -> same output.
 */
export function mergeTranscripts(prev: TranscriptTurn[], next: TranscriptTurn[], prefixes: string[] = []): TranscriptTurn[] {
  if (!prev.length) return [...next]
  if (!next.length) return [...prev]
  const max = Math.min(prev.length, next.length)
  let overlap = 0
  for (let k = max; k > 0; k--) {
    const a = prev.slice(prev.length - k).map((t) => turnKey(t, prefixes))
    const b = next.slice(0, k).map((t) => turnKey(t, prefixes))
    if (a.every((v, i) => v === b[i])) {
      overlap = k
      break
    }
  }
  return [...prev, ...next.slice(overlap)]
}

/** Merge a list of per-image transcripts in image order. */
export function mergeTranscriptList(parts: TranscriptTurn[][], prefixes: string[] = []): TranscriptTurn[] {
  return parts.reduce<TranscriptTurn[]>((acc, part) => mergeTranscripts(acc, part, prefixes), [])
}

/**
 * Longest finished run that starts at the first screenshot (streaming display).
 * A later screenshot that finishes first is held back: 原始聊天记录 must stay in image order.
 */
export function completedPrefix<T>(slots: readonly (T | null | undefined)[]): T[] {
  const out: T[] = []
  for (const slot of slots) {
    if (slot == null) break
    out.push(slot)
  }
  return out
}
