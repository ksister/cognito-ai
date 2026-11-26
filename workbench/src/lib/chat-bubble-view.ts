/**
 * T27 PR-B：把一次运行的 turns 转成聊天气泡模型（纯函数）。
 *
 * 显示层（气泡、名字、引用、时间、图片/文件占位）和交互层（标错、打分、输入框）分开：
 * 这个文件只产出「显示需要什么」；交互由页面用插槽传进去（T29 模拟问答复用同一套气泡）。
 */

export type BubbleVariant = "me" | "other" | "colleague" | "system"

export type BubbleMarkType = "speaker" | "text" | "extra" | "quote" | "unquote"

export type BubbleItem = {
  /** 第几条消息（从 1 数，只数发言行；标错用这个行号） */
  line: number
  variant: BubbleVariant
  speaker: string
  text: string
  kind: "speech" | "time"
  quote: { name: string; text: string; source?: "name" | "dup" | "reply" } | null
  /** 引用是谁说的：优先截图上的原始名字，没有才用「客户」「我」这类角色名。 */
  quoteDisplayName: string
  /** 引用的内容能在前面找到原话吗（找不到 = 待核对） */
  quoteVerified: boolean
  /** 飞书「回复」行但拆不出引用内容（待核对） */
  replyUnsplit: boolean
  /** 已经标过的类型（页面回填用；对不上当前转写的标记不算） */
  markedTypes: BubbleMarkType[]
  /** 对不上当前转写的标记数（重判过、原文变了；不显示红点，顶部提示） */
  staleMarkCount: number
  /** 标过之后的显示值（改过发言人/文字时用） */
  displaySpeaker: string
  displayText: string
  /** 原始值（悬停显示「原来的内容」） */
  originalSpeaker: string
  originalText: string
}

export type BubbleInputTurn = {
  speaker: string
  text: string
  kind?: "speech" | "time"
  quote?: { name: string; text: string; source?: "name" | "dup" | "reply" }
  /** 模型在截图里看到的原始发言人（引用显示名字时优先用它）。 */
  rawSpeaker?: string
}

export type BubbleInputMark = {
  line: number
  type: BubbleMarkType
  originalSpeaker: string
  originalText: string
  newSpeaker?: string
  newText?: string
}

const REPLY_LINE = /^[\s|｜]*回复\s*[^：:\n]{1,20}[：:]/

/** 角色名/泛称：不是「截图上的原始名字」。 */
const ROLE_NAMES = ["我", "客户", "我方同事", "对方", "未知", "系统", ""]

/** 转写正文里拼在末尾的引用段：「（引用 名字：内容）」。 */
const CITATION_SUFFIX = /\s*（引用\s[^：:\n]{1,40}：[\s\S]*）\s*$/

/** 气泡里不显示拼接的「（引用 …）」段，引用单独显示在气泡下面。 */
function stripCitation(text: string): string {
  return String(text ?? "").replace(CITATION_SUFFIX, "").trim() || String(text ?? "").trim()
}

/**
 * 旧结果文件里没有 `turn.quote`、只有正文拼的「（引用 名字：内容）」：
 * 从正文里解析出来显示，不能直接丢掉。
 */
export function parseCitationFromText(text: string): { name: string; text: string } | null {
  const s = String(text ?? "")
  const i = s.lastIndexOf("（引用 ")
  if (i < 0) return null
  const m = s.slice(i).match(/^（引用\s([^：:\n]{1,40})：([\s\S]*)）\s*$/)
  if (!m) return null
  const name = m[1].trim()
  const quoteText = m[2].trim()
  if (!name || !quoteText) return null
  return { name, text: quoteText }
}

/** 引用是谁：优先前面那条原话的截图原始名字（不是那种才用「客户」这类角色名）。 */
function resolveQuoteDisplayName(
  quote: { name: string; text: string },
  earlier: { text: string; rawSpeaker: string }[],
): string {
  const raw = String(quote.name ?? "").trim()
  if (raw && !ROLE_NAMES.includes(raw)) return raw
  for (const t of earlier) {
    const name = String(t.rawSpeaker ?? "").trim()
    if (!name || ROLE_NAMES.includes(name)) continue
    if (similarText(t.text, quote.text) >= 0.9) return name
  }
  return raw
}

function normalizeForMatch(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase()
}

/** 公共前后缀相似度（和 transcript-align 口径一致，这里留个小实现避免多一层依赖）。 */
export function similarText(a: string, b: string): number {
  const x = normalizeForMatch(a)
  const y = normalizeForMatch(b)
  if (!x && !y) return 1
  if (!x || !y) return 0
  if (x === y) return 1
  let p = 0
  const min = Math.min(x.length, y.length)
  while (p < min && x[p] === y[p]) p++
  let s = 0
  while (s < min - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++
  return (2 * (p + s)) / (x.length + y.length)
}

/** 引用内容能不能在前面消息里找到原话（整句 ≥0.9，或前面某条以它开头）。 */
export function quoteFoundInEarlier(earlierTexts: string[], quoteText: string): boolean {
  const q = normalizeForMatch(quoteText)
  if (!q) return false
  for (const t of earlierTexts) {
    const n = normalizeForMatch(t)
    if (!n) continue
    if (similarText(t, quoteText) >= 0.9) return true
    if (n.length >= q.length && n.startsWith(q)) return true
  }
  return false
}

/**
 * 生成气泡模型。`marks` 是这次运行已存的逐条标记（行号对应发言行）。
 */
export function buildBubbleItems(turns: BubbleInputTurn[], marks: BubbleInputMark[] = []): BubbleItem[] {
  const byLine = new Map<number, BubbleInputMark[]>()
  for (const m of marks) {
    const list = byLine.get(m.line) ?? []
    list.push(m)
    byLine.set(m.line, list)
  }
  const earlier: { text: string; rawSpeaker: string }[] = []
  const items: BubbleItem[] = []
  let line = 0
  for (const turn of turns) {
    if (turn.kind === "time") {
      items.push({
        line: 0,
        variant: "system",
        speaker: "",
        text: turn.text,
        kind: "time",
        quote: null,
        quoteDisplayName: "",
        quoteVerified: true,
        replyUnsplit: false,
        markedTypes: [],
        staleMarkCount: 0,
        displaySpeaker: "",
        displayText: turn.text,
        originalSpeaker: "",
        originalText: turn.text,
      })
      continue
    }
    line++
    const allMarks = byLine.get(line) ?? []
    // 标记保护：只认对得上当前转写的（发言人一致、文字归一化后一致）；对不上的不算标记，只计数。
    const list = allMarks.filter((m) => markMatchesTurn(m, turn.speaker, turn.text))
    const staleMarkCount = allMarks.length - list.length
    const speakerMark = [...list].reverse().find((m) => m.type === "speaker" && m.newSpeaker)
    const textMark = [...list].reverse().find((m) => m.type === "text" && m.newText != null)
    const variant: BubbleVariant =
      turn.speaker === "我"
        ? "me"
        : turn.speaker === "我方同事"
          ? "colleague"
          : turn.speaker === "未知" || /^(系统|提示)/.test(turn.speaker)
            ? "system"
            : "other"
    // 引用：优先用结果文件里的 turn.quote；旧数据没有 quote 时从正文拼接处解析（不能丢）。
    const quote = turn.quote ?? parseCitationFromText(turn.text)
    const quoteVerified = quote ? quoteFoundInEarlier(earlier.map((e) => e.text), quote.text) : true
    const quoteDisplayName = quote
      ? resolveQuoteDisplayName(quote, earlier.map((e) => ({ text: e.text, rawSpeaker: e.rawSpeaker })))
      : ""
    const replyUnsplit = !quote && REPLY_LINE.test(String(turn.text ?? ""))
    earlier.push({ text: turn.text, rawSpeaker: turn.rawSpeaker ?? turn.speaker })
    items.push({
      line,
      variant,
      speaker: turn.speaker,
      text: turn.text,
      kind: "speech",
      quote,
      quoteDisplayName,
      quoteVerified,
      replyUnsplit,
      markedTypes: [...new Set(list.map((m) => m.type))],
      staleMarkCount,
      displaySpeaker: speakerMark?.newSpeaker ?? turn.speaker,
      // 气泡里不显示正文里拼的「（引用 …）」（引用单独一行灰字）；纯文本视图仍用 turn.text。
      displayText: textMark?.newText != null ? stripCitation(textMark.newText) : stripCitation(turn.text),
      originalSpeaker: turn.speaker,
      originalText: turn.text,
    })
  }
  return items
}

export type BubbleStats = {
  speakerChanged: number
  textChanged: number
  quoteMarked: number
  extraMarked: number
  /** 「不是引用」：应该拆回成单独一条消息 */
  unquoteMarked: number
  /** 标记对不上当前转写（重判过）——不显示红点，顶部提示重新核对 */
  staleMarks: number
  /** 待核对：引用找不到原话 + 回复拆不出引用 */
  pending: { line: number; reason: "quote-missing" | "reply-unsplit" }[]
}

/** 标记是否还对得上当前转写：发言人一致、文字归一化后一致。 */
export function markMatchesTurn(mark: BubbleInputMark, speaker: string, text: string): boolean {
  if (mark.originalSpeaker.trim() !== String(speaker ?? "").trim()) return false
  return normalizeForMatch(mark.originalText) === normalizeForMatch(text)
}

export function summarizeBubbles(items: BubbleItem[]): BubbleStats {
  const stats: BubbleStats = {
    speakerChanged: 0,
    textChanged: 0,
    quoteMarked: 0,
    extraMarked: 0,
    unquoteMarked: 0,
    staleMarks: 0,
    pending: [],
  }
  for (const item of items) {
    if (item.markedTypes.includes("speaker")) stats.speakerChanged++
    if (item.markedTypes.includes("text")) stats.textChanged++
    if (item.markedTypes.includes("quote")) stats.quoteMarked++
    if (item.markedTypes.includes("extra")) stats.extraMarked++
    if (item.markedTypes.includes("unquote")) stats.unquoteMarked++
    stats.staleMarks += item.staleMarkCount
    if (!item.quoteVerified) stats.pending.push({ line: item.line, reason: "quote-missing" })
    if (item.replyUnsplit) stats.pending.push({ line: item.line, reason: "reply-unsplit" })
  }
  return stats
}

/** 是否「我」的气泡（右侧、绿色）。 */
export function isMeBubble(item: BubbleItem): boolean {
  return item.variant === "me"
}
