import { formatScreenshotChat, normalizeSpeakerName, type TranscriptTurn } from "./transcript.ts"

/**
 * T27 PR2：回放「从截图重新转写」的发言人判断（配合提示词 v1 输出的 `side`）。
 *
 * 规则（11-25 用户定）：
 *  ① 以气泡在哪一侧为准：右侧是我，左侧是客户；
 *  ② 「我」「客户」「对方」这类泛称不算昵称，不作为判断依据；
 *  ③ 真名昵称只用来交叉核对：昵称属于我但气泡在左、或昵称不属于我但气泡在右，
 *     保持截图上的原样并记 uncertain（不硬改成我/客户）；
 *  ④ 没有侧别信息时才只看真名昵称；两样都没有就标「未知」。
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
}

/** 按「气泡左右为主、昵称交叉核对」定发言人。 */
export function resolveSpeakerTurns(turns: TranscriptTurn[], settings: SpeakerSettings): ResolvedTranscript {
  const resolved: TranscriptTurn[] = []
  let mineButLeft = 0
  let otherButRight = 0
  let noSideMine = 0
  let colleague = 0
  let unknown = 0

  for (const turn of turns) {
    if (turn.kind === "time") {
      resolved.push(turn)
      continue
    }
    const speaker = turn.speaker.trim()
    const mine = isMyNickname(speaker, settings)
    const real = isRealName(speaker, settings)

    // ③ 交叉核对：昵称和气泡位置对不上时，保留截图上的原样。
    if (turn.side === "left" && mine) {
      mineButLeft++
      resolved.push({ ...turn, speaker: speaker || ME })
      continue
    }

    // 我方同事：名字带公司前缀、但不是我本人；不管气泡在哪边都算我方。
    if (isCompanyColleague(speaker, settings)) {
      colleague++
      resolved.push({ ...turn, speaker: COLLEAGUE })
      continue
    }

    if (turn.side === "right" && real && !mine) {
      otherButRight++
      resolved.push({ ...turn, speaker })
      continue
    }

    // ①② 以气泡为准；泛称和空名字不当作身份。
    if (turn.side === "right") {
      resolved.push({ ...turn, speaker: ME })
      continue
    }
    if (turn.side === "left") {
      resolved.push({ ...turn, speaker: real ? speaker : CUSTOMER })
      continue
    }

    // ④ 没有侧别：只看真名昵称。
    if (mine) {
      noSideMine++
      resolved.push({ ...turn, speaker: ME })
      continue
    }
    if (real) {
      resolved.push({ ...turn, speaker })
      continue
    }
    unknown++
    resolved.push({ ...turn, speaker: UNKNOWN })
  }

  const uncertain: string[] = []
  if (mineButLeft) {
    uncertain.push(`有 ${mineButLeft} 条消息的昵称在「我的昵称」里，但气泡在左侧；已保留截图上的昵称，请核对`)
  }
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
  return { turns: resolved, uncertain }
}

/** 转写行 → 原始聊天记录格式（首行仍是 OCR 标记，由 formatScreenshotChat 加）。 */
export function resolveAndFormat(
  turns: TranscriptTurn[],
  settings: SpeakerSettings,
): { chat: string; uncertain: string[]; turns: TranscriptTurn[] } {
  const { turns: resolved, uncertain } = resolveSpeakerTurns(turns, settings)
  return { chat: formatScreenshotChat(resolved), uncertain, turns: resolved }
}
