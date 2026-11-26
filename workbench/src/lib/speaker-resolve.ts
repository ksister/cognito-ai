import { formatScreenshotChat, normalizeSpeakerName, type TranscriptTurn } from "./transcript.ts"
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
 * 引用识别：把「系统提示」+「名字：内容」的行并进它前面那条消息。
 *
 * 只有这个名字在本条聊天里出现过（真名发言人，或 extraNames 里的我的昵称）才算引用；
 * 名字没见过的保留原样（可能是模型把别的东西错标成系统提示，交给人工判断）。
 *
 * 返回的 turns 已经不含引用行，`quotes` 是识别出的条数。
 */
export function mergeQuoteTurns(
  turns: TranscriptTurn[],
  extraNames: string[] = [],
): { turns: TranscriptTurn[]; quotes: number } {
  const known = new Set<string>()
  for (const t of turns) {
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
  for (const turn of turns) {
    if (turn.kind !== "time" && isSystemHintSpeaker(turn.speaker)) {
      const m = turn.text.match(QUOTE_LINE)
      const quotedName = m?.[1]?.trim() ?? ""
      const quotedText = m?.[2]?.trim() ?? ""
      const matched = quotedName && quoteNameSeen(known, quotedName)
      // 往前找最近的一条发言（跳过时间分隔行）
      let prev = -1
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].kind !== "time") {
          prev = i
          break
        }
      }
      if (matched && quotedText && prev >= 0) {
        const base = out[prev]
        const extra = `（引用 ${quotedName}：${quotedText}）`
        out[prev] = { ...base, text: base.text ? `${base.text}${extra}` : extra }
        quotes++
        continue
      }
    }
    out.push(turn)
  }
  return { turns: out, quotes }
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
}

/** 定好发言人后同时留下「模型看到的原始名字」，重判和排查都要用。 */
function withSpeaker(turn: TranscriptTurn, speaker: string): TranscriptTurn {
  return { ...turn, speaker, rawSpeaker: turn.rawSpeaker ?? turn.speaker }
}

/** 按「真名优先、其余看气泡」定发言人；先把引用行并进前一条。 */
export function resolveSpeakerTurns(turns: TranscriptTurn[], settings: SpeakerSettings): ResolvedTranscript {
  const withQuotes = mergeQuoteTurns(turns, settings.myNicknames)
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
  if (withQuotes.quotes) uncertain.push(`有 ${withQuotes.quotes} 行是引用（「名字：内容」），已并进上一条消息，标为「（引用 …）」`)
  return { turns: resolved, uncertain, quotes: withQuotes.quotes }
}

/** 转写行 → 原始聊天记录格式（首行仍是 OCR 标记，由 formatScreenshotChat 加）。 */
export function resolveAndFormat(
  turns: TranscriptTurn[],
  settings: SpeakerSettings,
): { chat: string; uncertain: string[]; turns: TranscriptTurn[]; quotes: number } {
  const { turns: resolved, uncertain, quotes } = resolveSpeakerTurns(turns, settings)
  return { chat: formatScreenshotChat(resolved), uncertain, turns: resolved, quotes }
}
