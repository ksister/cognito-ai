import {
  cleanWindowTitle,
  formatScreenshotChat,
  normalizeSpeakerName,
  splitSpeakerContentTurn,
  type TranscriptTurn,
} from "./transcript.ts"
import { normalizeSpeakerForCompare } from "./transcript-align.ts"

/**
 * T27 / T33：发言人判断（主流程和回放共用）。
 *
 * 规则（11-25 用户定，11-26 加引用识别）：
 *  ① 截图真名命中「我的昵称」（去掉公司前缀后比）→ 我，不管哪一侧；
 *  ② 名字带我方公司前缀、不是我 → 我方同事；
 *  ③ 没有名字/泛称 → 看侧别（右侧是我、左侧客户方）；
 *  ④ 真名不是我却在右侧 → 保持原名 + uncertain；
 *  ⑤ 都没有 → 未知；
 *  ⑥ 引用识别：被转成「系统提示」的行，内容是「某个名字：内容」、且这个名字在本条聊天里
 *     出现过（含我的昵称）→ 并入前一条消息，写成「（引用 名字：内容）」，不单独成行。
 *
 * 只改「这条转写算谁的」，不改文字本身；时间分隔行不参与判断。
 *
 * Script-safe: no `server-only`, `.ts` suffix on relative runtime imports.
 */

export type SpeakerSettings = {
  myNicknames: string[]
  companyPrefixes: string[]
}

export const ME = "我"
export const CUSTOMER = "客户"
export const COLLEAGUE = "我方同事"
export const UNKNOWN = "未知"

/** 泛称：不能拿来判断「这个人是谁」。 */
export const GENERIC_SPEAKERS = ["我", "客户", "对方", "本人", "自己", "对方用户"] as const

/** 被模型当成「系统提示」的发言人写法（引用行常见）。 */
export const SYSTEM_HINT_SPEAKERS = ["系统提示", "系统消息", "系统通知", "系统", "提示"] as const

export function isSystemHintSpeaker(name: string): boolean {
  const n = normalizeSpeakerForCompare(name)
  return Boolean(n) && (SYSTEM_HINT_SPEAKERS as readonly string[]).includes(n)
}

const QUOTE_LINE = /^([^：:\n]{1,40})[：:]\s*([\s\S]+)$/
/** 名字里不该出现的句子标点（出现就说明冒号前是一句话，不是「名字：内容」）。 */
const NAME_BAD_CHARS = /[。！？；，、,.!?;]/

/**
 * 只看「还没拼过引用的正文」：已经并过引用的消息，正文里有「（引用 名字：内容）」，
 * 再拿去判断会把「（引用 名字」当成新的「名字」重复合并，所以先截掉。
 */
function textHead(text: string): string {
  const i = String(text ?? "").indexOf("（引用 ")
  return i >= 0 ? String(text).slice(0, i) : String(text ?? "")
}

/** 窗口标题里不能当名字的常见词。 */
const TITLE_STOP_WORDS = ["技术支持", "客服", "支持", "群聊", "私聊", "工作", "生活", "客户", "对方", "聊天"]

/**
 * 从窗口标题里取「可能的人名」：私聊标题常见「工作 宇创 魏笑凡」，
 * 单聊里对方的发言会被标成「客户」、人名从没以发言人出现，所以要把标题里的人名也算作见过。
 * 做法：去掉人数括号、按空格/分隔符切段、去掉常见业务词，再补上整条标题（用于后缀匹配）。
 */
export function namesFromWindowTitle(rawTitle: string): string[] {
  const title = cleanWindowTitle(rawTitle).replace(/[（(]\s*\d{1,3}\s*[)）]/g, "")
  if (!title) return []
  const segments = title
    .split(/[\s\u3000·・.,，、;；:：\-—_|/\\()（）\[\]【】"'“”‘’]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const names = new Set<string>()
  for (const seg of segments) {
    if (TITLE_STOP_WORDS.includes(seg)) continue
    if (normalizeSpeakerForCompare(seg).length >= 2) names.add(seg)
  }
  // 整条标题也加进去：引用写成「工作 宇创 魏笑凡：…」时靠后缀匹配命中。
  if (normalizeSpeakerForCompare(title).length >= 2) names.add(title)
  return [...names]
}

/**
 * 引用的名字算不算「在本条聊天里出现过」：
 * 完全相同，或者一方是另一方后缀（引用写成「工作 宇创 魏笑凡」而聊天里是「魏笑凡」）。
 * 后缀匹配要求两边都 ≥2 个字，避免单字撞名。
 */
function quoteNameSeen(known: Set<string>, quotedName: string): boolean {
  const q = normalizeSpeakerForCompare(quotedName)
  if (!q) return false
  for (const k of known) {
    if (k === q) return true
    if (q.length >= 2 && k.length > q.length && k.endsWith(q)) return true
    if (k.length >= 2 && q.length > k.length && q.endsWith(k)) return true
  }
  return false
}

/**
 * 引用识别（PR-A 放宽）：不管一行标的发言人是谁，满足任一条件就当作引用、并进它上一条消息：
 *  ① 内容是「见过的名字：内容」（见过的名字 = 发言人真名 / 我的昵称 / 窗口标题里的人名，按后缀匹配）；
 *  ② 内容和前面某条消息几乎相同：归一后长度 ≥ {@link DUP_QUOTE_MIN_LEN} 个字、相似度 ≥ {@link DUP_QUOTE_SIM}。
 *
 * ② 的取舍理由：R079 / R161 的实测里，自然重复的消息（「好的」「收到」「OK」）都在 5 个字以内，
 * 而用户指出的「和前面完全重复」的引用行是 20 个字以上的整句；所以用 12 个字当门槛，
 * 把短消息的自然重复排除掉。真的把同一句长话发两遍时也会被当成引用（无法从文本区分），
 * 这类情况会在 uncertain 里注明，PR-B 的气泡界面可以逐条改回来。
 *
 * 跨截图交界处同样适用：这里处理的是已经按顺序拼好的整段 turns。
 * 合并的行会写 `turn.quote = { name, text }`，正文仍拼成「（引用 名字：内容）」。
 *
 * 返回的 turns 已经不含引用行。
 */
export function mergeQuoteTurns(
  turns: TranscriptTurn[],
  extraNames: string[] = [],
): { turns: TranscriptTurn[]; quotes: number; quotesByName: number; quotesByDup: number } {
  // 先修一种坏形状：模型把「名字：内容」整个塞进发言人、正文是空的（R079 里 lily 那行就是这样，
  // 导致「lily」明明在昵称里却没被认成我）。拆开发言人和正文再判断。
  const normalized = turns.map((t) => splitSpeakerContent(t))

  const known = new Set<string>()
  for (const t of normalized) {
    if (t.kind === "time" || isSystemHintSpeaker(t.speaker)) continue
    const n = normalizeSpeakerForCompare(t.speaker)
    if (n && !isGenericSpeaker(t.speaker)) known.add(n)
  }
  for (const name of extraNames) {
    const n = normalizeSpeakerForCompare(name)
    if (n) known.add(n)
  }

  const out: TranscriptTurn[] = []
  let quotes = 0
  let quotesByName = 0
  let quotesByDup = 0

  const appendQuote = (baseIdx: number, quote: { name: string; text: string }) => {
    const base = out[baseIdx]
    const form = base.text ? `${base.text}（引用 ${quote.name}：${quote.text}）` : `（引用 ${quote.name}：${quote.text}）`
    out[baseIdx] = { ...base, text: form, quote }
  }
  const lastBase = (): number => {
    for (let i = out.length - 1; i >= 0; i--) if (out[i].kind !== "time") return i
    return -1
  }

  for (let index = 0; index < normalized.length; index++) {
    const turn = normalized[index]
    if (turn.kind === "time") {
      out.push(turn)
      continue
    }
    const prev = lastBase()

    // ① 「见过的名字：内容」
    const head = textHead(turn.text)
    const m = head.match(QUOTE_LINE)
    const quotedName = m?.[1]?.trim() ?? ""
    const quotedText = m?.[2]?.trim() ?? ""
    const nameLooksLikeName = Boolean(quotedName) && quotedName.length <= 20 && !NAME_BAD_CHARS.test(quotedName)
    if (prev >= 0 && m && quotedText && nameLooksLikeName && quoteNameSeen(known, quotedName)) {
      appendQuote(prev, { name: quotedName, text: quotedText })
      quotes++
      quotesByName++
      continue
    }

    // ② 和前面某条消息几乎相同（长句才算）
    const dupSource = prev >= 0 ? findNearDuplicate(normalized, index) : -1
    if (dupSource >= 0) {
      const source = normalized[dupSource]
      appendQuote(prev, { name: source.speaker.trim() || UNKNOWN, text: source.text })
      quotes++
      quotesByDup++
      continue
    }

    out.push(turn)
  }

  return { turns: out, quotes, quotesByName, quotesByDup }
}

/** 「和前面某条消息几乎相同」的判定参数（理由见 mergeQuoteTurns 注释）。 */
export const DUP_QUOTE_MIN_LEN = 12
export const DUP_QUOTE_SIM = 0.9

/** 找前面最近的一条「长句、几乎相同、而且是别人说的」的发言；找不到返回 -1。 */
function findNearDuplicate(turns: TranscriptTurn[], index: number): number {
  const current = normalizeForAlignLoose(turns[index].text)
  if (current.length < DUP_QUOTE_MIN_LEN) return -1
  const currentSpeaker = normalizeSpeakerForCompare(turns[index].speaker)
  for (let k = index - 1; k >= 0; k--) {
    const t = turns[k]
    if (t.kind === "time") continue
    const prev = normalizeForAlignLoose(t.text)
    if (prev.length < DUP_QUOTE_MIN_LEN) continue
    if (similarityLoose(prev, current) < DUP_QUOTE_SIM) continue
    // 同一个人把同一句长话又发一遍 = 真的重复发消息，不当引用（否则会把正常发言吞掉）；
    // 别人说的同一句长话重复出现，才是客户端展示的引用块。
    if (normalizeSpeakerForCompare(t.speaker) === currentSpeaker) continue
    return k
  }
  return -1
}

/** 去掉空白/标点/符号后的文本（只看字和数字）。 */
function normalizeForAlignLoose(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase()
}

/** 公共前后缀占比，和 transcript-align 的口径一致（避免循环依赖只在这里留一份小实现）。 */
function similarityLoose(a: string, b: string): number {
  if (!a && !b) return 1
  if (!a || !b) return 0
  if (a === b) return 1
  let prefix = 0
  const min = Math.min(a.length, b.length)
  while (prefix < min && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < min - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  return (2 * (prefix + suffix)) / (a.length + b.length)
}

/** 模型把「名字：内容」整个塞进发言人时拆开；正常的行原样返回。 */
export function splitSpeakerContent(turn: TranscriptTurn): TranscriptTurn {
  const split = splitSpeakerContentTurn(turn)
  if (split === turn) return turn
  return { ...split, rawSpeaker: turn.rawSpeaker ?? split.speaker }
}

export function isGenericSpeaker(name: string): boolean {
  const n = normalizeSpeakerName(String(name ?? ""), [])
  return !n || (GENERIC_SPEAKERS as readonly string[]).includes(n)
}

/** 去掉公司前缀和表情后，昵称是否命中「我的昵称」。 */
export function isMyNickname(speaker: string, settings: SpeakerSettings): boolean {
  const name = normalizeSpeakerName(speaker, settings.companyPrefixes)
  if (!name || isGenericSpeaker(name)) return false
  return settings.myNicknames.some((mine) => {
    const target = normalizeSpeakerName(mine, settings.companyPrefixes)
    return Boolean(target) && !isGenericSpeaker(target) && target === name
  })
}

/** 真名昵称（既不是泛称，也不是空）。 */
export function isRealName(speaker: string, settings: SpeakerSettings): boolean {
  const name = normalizeSpeakerName(speaker, settings.companyPrefixes)
  return Boolean(name) && !isGenericSpeaker(name)
}

/**
 * 名字上带我方公司前缀、但不在「我的昵称」里 = 我方同事。
 * 依据：用户截图里同事都在左侧、显示为「公司前缀 + 名字」；不能把它算成客户方
 * （否则同事给的解决方法会被当成客户说的）。
 */
export function isCompanyColleague(speaker: string, settings: SpeakerSettings): boolean {
  const raw = normalizeSpeakerName(String(speaker ?? ""), [])
  if (!raw || isGenericSpeaker(raw)) return false
  const stripped = normalizeSpeakerName(raw, settings.companyPrefixes)
  if (!stripped || stripped === raw) return false // 没有可识别的前缀
  if (isGenericSpeaker(stripped)) return false // 「公司前缀 + 客户」这种泛称
  if (isMyNickname(raw, settings)) return false // 是我自己
  return true
}

export type ResolvedTranscript = {
  turns: TranscriptTurn[]
  /** 不能确定的地方（只报数量，不带名字）。 */
  uncertain: string[]
  /** 识别出的引用行数（已并进前一条消息）。 */
  quotes: number
  /** 其中按「名字：内容」认出的行数。 */
  quotesByName: number
  /** 其中按「和前面消息几乎重复」认出的行数。 */
  quotesByDup: number
}

/** 定好发言人后同时留下「模型看到的原始名字」，重判和排查都要用。 */
function withSpeaker(turn: TranscriptTurn, speaker: string): TranscriptTurn {
  return { ...turn, speaker, rawSpeaker: turn.rawSpeaker ?? turn.speaker }
}

/** 按「真名优先、其余看气泡」定发言人；先把引用行并进前一条。 */
export function resolveSpeakerTurns(
  turns: TranscriptTurn[],
  settings: SpeakerSettings,
  extraNames: string[] = [],
): ResolvedTranscript {
  const withQuotes = mergeQuoteTurns(turns, [...settings.myNicknames, ...extraNames])
  const resolved: TranscriptTurn[] = []
  let otherButRight = 0
  let noSideMine = 0
  let colleague = 0
  let unknown = 0

  for (const turn of withQuotes.turns) {
    if (turn.kind === "time") {
      resolved.push(turn)
      continue
    }
    const speaker = turn.speaker.trim()
    const mine = isMyNickname(speaker, settings)
    const real = isRealName(speaker, settings)

    // ① 截图上的真名命中「我的昵称」→ 我，不管气泡在哪一侧
    //    （飞书/钉钉有「全部靠左」的布局，我自己的深蓝气泡也在左边）。
    if (mine) {
      if (!turn.side) noSideMine++
      resolved.push(withSpeaker(turn, ME))
      continue
    }

    // ② 名字带我方公司前缀、不是我本人 → 我方同事。
    if (isCompanyColleague(speaker, settings)) {
      colleague++
      resolved.push(withSpeaker(turn, COLLEAGUE))
      continue
    }

    // ④ 名字不是我、却在右侧：保留原名并记 uncertain（不硬算成客户）。
    if (turn.side === "right" && real) {
      otherButRight++
      resolved.push(withSpeaker(turn, speaker))
      continue
    }

    // ③ 其余按气泡：右侧是我（没名字/泛称），左侧有真名保留真名、否则客户方。
    if (turn.side === "right") {
      resolved.push(withSpeaker(turn, ME))
      continue
    }
    if (turn.side === "left") {
      resolved.push(withSpeaker(turn, real ? speaker : CUSTOMER))
      continue
    }

    // ⑤ 没有侧别：有真名就保留，什么都没有标「未知」。
    if (real) {
      resolved.push(withSpeaker(turn, speaker))
      continue
    }
    unknown++
    resolved.push(withSpeaker(turn, UNKNOWN))
  }

  const uncertain: string[] = []
  if (otherButRight) {
    uncertain.push(`有 ${otherButRight} 条消息的昵称不在「我的昵称」里，但气泡在右侧；已保留截图上的昵称，请核对`)
  }
  if (colleague) {
    uncertain.push(`有 ${colleague} 条消息的昵称带我方公司前缀、不在「我的昵称」里，已记为「${COLLEAGUE}」`)
  }
  if (noSideMine) {
    uncertain.push(`有 ${noSideMine} 条消息读不出气泡左右，是按昵称认成「我」的`)
  }
  if (unknown) uncertain.push(`有 ${unknown} 条消息既没有昵称、也读不出气泡左右，发言人标为「未知」`)
  if (withQuotes.quotes) {
    const parts: string[] = []
    if (withQuotes.quotesByName) parts.push(`按「名字：内容」${withQuotes.quotesByName} 行`)
    if (withQuotes.quotesByDup) parts.push(`和前面消息几乎重复${withQuotes.quotesByDup} 行`)
    uncertain.push(`有 ${withQuotes.quotes} 行是引用（${parts.join("、")}），已并进上一条消息，标为「（引用 …）」`)
  }
  return { turns: resolved, uncertain, quotes: withQuotes.quotes, quotesByName: withQuotes.quotesByName, quotesByDup: withQuotes.quotesByDup }
}

/** 转写行 → 原始聊天记录格式（首行仍是 OCR 标记，由 formatScreenshotChat 加）。 */
export function resolveAndFormat(
  turns: TranscriptTurn[],
  settings: SpeakerSettings,
  extraNames: string[] = [],
): { chat: string; uncertain: string[]; turns: TranscriptTurn[]; quotes: number; quotesByName: number; quotesByDup: number } {
  const { turns: resolved, uncertain, quotes, quotesByName, quotesByDup } = resolveSpeakerTurns(turns, settings, extraNames)
  return { chat: formatScreenshotChat(resolved), uncertain, turns: resolved, quotes, quotesByName, quotesByDup }
}
