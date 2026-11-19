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

const SHANGHAI = "Asia/Shanghai"
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/**
 * 把飞书日期值换算成 Asia/Shanghai 的 YYYY-MM-DD。
 * 兼容三种真实格式：13 位毫秒数、ISO 8601（带时区的按上海换算）、纯日期。
 */
export function shanghaiDate(value: string | number | null | undefined): string {
  if (value == null) return ""
  if (typeof value === "number") {
    return Number.isFinite(value) ? dayFormatter.format(new Date(value)) : ""
  }
  const text = String(value).trim()
  if (!text) return ""
  if (/^\d{13}$/.test(text)) return dayFormatter.format(new Date(Number(text)))
  if (/^\d{10}$/.test(text)) return dayFormatter.format(new Date(Number(text) * 1000))
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return ""
  return dayFormatter.format(parsed)
}

/** 只比较日期部分：飞书日期列可能带时间或时间戳。 */
export function sameDay(a: string, b: string): boolean {
  const left = shanghaiDate(a)
  const right = shanghaiDate(b)
  return Boolean(left) && left === right
}

/**
 * 单元格取值。
 * - 文本段数组（`[{text, type}]`）是同一个富文本单元格，**直接拼接、不加分隔符**；
 * - 人员、多选这类列表才用「、」连接；
 * - 对象取 name / text / value。
 */
export function cellText(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    const allTextSegments =
      value.length > 0 &&
      value.every((item) => item !== null && typeof item === "object" && typeof (item as { text?: unknown }).text === "string")
    if (allTextSegments) return value.map((item) => String((item as { text: string }).text)).join("")
    return value.map(cellText).join("、")
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    return String(obj.name ?? obj.text ?? obj.value ?? "")
  }
  return ""
}

const clean = (v: string | undefined | null) => (v ?? "").replace(/\s+/g, " ").trim()

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
