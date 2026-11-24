import { formatScreenshotChat, normalizeSpeakerName, type TranscriptTurn } from "./transcript.ts"

/**
 * T27 PR2：回放「从截图重新转写」的发言人判断（提示词 v2 配套的确定性规则）。
 *
 * 判断顺序：
 *  1. 昵称命中「我的昵称」（去掉我方公司前缀后**完全相等**）→ 我；
 *  2. 否则看气泡位置：右侧 → 我；左侧 → 客户（有昵称就保留昵称原文）；
 *  3. 没有气泡位置也没有昵称 → 保留原发言人，识别不了记「未知」并写 uncertain。
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

/** 去掉公司前缀和表情后，昵称是否命中「我的昵称」。 */
export function isMyNickname(speaker: string, settings: SpeakerSettings): boolean {
  const name = normalizeSpeakerName(speaker, settings.companyPrefixes)
  if (!name) return false
  return settings.myNicknames.some((mine) => {
    const target = normalizeSpeakerName(mine, settings.companyPrefixes)
    return Boolean(target) && target === name
  })
}

export type ResolvedTranscript = {
  turns: TranscriptTurn[]
  /** 不能确定的地方（数量，不带名字）。 */
  uncertain: string[]
}

/**
 * 按「昵称 + 气泡左右」定发言人。
 * 右侧但昵称不在配置里时仍记为「我」（气泡位置是可靠信号），并提示去设置页补昵称。
 */
export function resolveSpeakerTurns(turns: TranscriptTurn[], settings: SpeakerSettings): ResolvedTranscript {
  const resolved: TranscriptTurn[] = []
  let unmatchedRight = 0
  let unknown = 0

  for (const turn of turns) {
    if (turn.kind === "time") {
      resolved.push(turn)
      continue
    }
    const speaker = turn.speaker.trim()
    if (isMyNickname(speaker, settings)) {
      resolved.push({ ...turn, speaker: ME })
      continue
    }
    if (turn.side === "right") {
      if (speaker && speaker !== ME) unmatchedRight++
      resolved.push({ ...turn, speaker: ME })
      continue
    }
    if (turn.side === "left") {
      resolved.push({ ...turn, speaker: speaker && speaker !== CUSTOMER ? speaker : CUSTOMER })
      continue
    }
    // 没有气泡位置：有昵称就保留，没有就记未知。
    if (!speaker || speaker === ME) {
      unknown++
      resolved.push({ ...turn, speaker: "未知" })
      continue
    }
    resolved.push(turn)
  }

  const uncertain: string[] = []
  if (unmatchedRight) {
    uncertain.push(
      `有 ${unmatchedRight} 条右侧（我）消息的昵称不在设置页的「我的昵称」里，已按气泡位置记为「我」；如果其中有客户，去设置页核对昵称`,
    )
  }
  if (unknown) uncertain.push(`有 ${unknown} 条消息没有昵称、也读不出气泡在左还是右，发言人标为「未知」`)
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
