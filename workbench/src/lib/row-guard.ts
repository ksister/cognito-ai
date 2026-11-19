/**
 * T31：更新飞书已有行之前的核对。
 *
 * 背景：本地记录 `feishu_record_id` 指向的行，可能因为人工粘贴/编辑被换成了别的问题
 * （11-10 实测：编号留在行里，内容被换掉）。T4 的更新路径原本无条件相信这个行号，
 * 于是「同步飞书」会把别的问题的行覆盖掉。
 *
 * 规则（技术总监 11-18 确认）：更新前只读取目标行，要求
 * 1) 目标行的「本地记录ID」与本地记录一致；
 * 2) 问题名称 或 日期 至少一项一致。
 * 不满足就不更新，交给用户核对。
 */

export type RowSnapshot = {
  localId: string
  title: string
  date: string
}

export type RowGuardResult = { ok: true } | { ok: false; reason: string }

const clean = (v: string | undefined | null) => (v ?? "").replace(/\s+/g, " ").trim()
const day = (v: string) => clean(v).slice(0, 10)

/** 只比较日期部分：飞书日期列可能带时间。 */
export function sameDay(a: string, b: string): boolean {
  const left = day(a)
  const right = day(b)
  return Boolean(left) && left === right
}

export function checkTargetRow(expected: RowSnapshot, actual: RowSnapshot): RowGuardResult {
  const wantId = clean(expected.localId)
  const gotId = clean(actual.localId)

  if (!wantId) {
    return { ok: false, reason: "本地记录没有本地记录ID，无法核对目标行，未更新" }
  }
  if (gotId !== wantId) {
    return {
      ok: false,
      reason: `目标行的本地记录ID是「${gotId || "空"}」，和本地记录的「${wantId}」不一致，未更新`,
    }
  }

  const titleMatches = Boolean(clean(expected.title)) && clean(expected.title) === clean(actual.title)
  const dateMatches = sameDay(expected.date, actual.date)
  if (!titleMatches && !dateMatches) {
    return { ok: false, reason: "目标行的问题名称和日期都和本地记录对不上，未更新" }
  }

  return { ok: true }
}
