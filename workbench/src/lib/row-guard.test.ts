import { describe, expect, it } from "vitest"
import { cellText, checkTargetRow, sameDay, shanghaiDate } from "./row-guard"

const expected = { localId: "AE-20261110-01", title: "模板匹配耗时长、识别不准（取图）", date: "2026-11-10" }

describe("row-guard：更新飞书行之前的核对（T31）", () => {
  it("本地记录ID 一致且标题一致 → 允许更新", () => {
    expect(checkTargetRow(expected, { ...expected })).toEqual({ ok: true })
  })

  it("本地改了标题、日期一致 → 放行", () => {
    expect(
      checkTargetRow(expected, { localId: expected.localId, title: "工作台里改过的标题", date: "2026-11-10" }),
    ).toEqual({ ok: true })
  })

  it("本地记录ID 不一致 → 拒绝更新，提示不一致", () => {
    const r = checkTargetRow(expected, { localId: "AE-20260101-09", title: expected.title, date: expected.date })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("不一致")
  })

  it("本地记录ID 一致但标题和日期都对不上 → 拒绝更新", () => {
    const r = checkTargetRow(expected, { localId: expected.localId, title: "外部触发取图偶发失败", date: "2026-11-05" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("对不上")
  })

  it("本地记录没有本地记录ID → 拒绝更新（无法核对）", () => {
    const r = checkTargetRow({ ...expected, localId: "" }, { ...expected })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("没有本地记录ID")
  })

  it("目标行本地记录ID 为空 → 拒绝更新", () => {
    const r = checkTargetRow(expected, { localId: "", title: expected.title, date: expected.date })
    expect(r.ok).toBe(false)
  })

  it("忽略多余空白：标题前后空格不影响判断", () => {
    expect(
      checkTargetRow(expected, {
        localId: ` ${expected.localId} `,
        title: `  ${expected.title}  `,
        date: expected.date,
      }),
    ).toEqual({ ok: true })
  })

  it("标题被拆成两段时也能比对上（文本段直接拼接）", () => {
    const segments = [
      { text: "模板匹配耗时长", type: "text" },
      { text: "、识别不准（取图）", type: "text" },
    ]
    expect(cellText(segments)).toBe(expected.title)
    expect(checkTargetRow(expected, { localId: expected.localId, title: cellText(segments), date: "2026-11-10" })).toEqual({
      ok: true,
    })
  })

  it("人员/多选这类列表仍用顿号连接", () => {
    expect(cellText(["2D", "3D"])).toBe("2D、3D")
    expect(cellText([{ name: "张珂" }, { name: "李四" }])).toBe("张珂、李四")
  })
})

describe("row-guard：日期格式兼容（T31 评审补充）", () => {
  it("纯日期", () => {
    expect(shanghaiDate("2026-11-10")).toBe("2026-11-10")
    expect(sameDay("2026-11-10", "2026-11-10")).toBe(true)
  })

  it("13 位毫秒数按 Asia/Shanghai 换算", () => {
    // 2026-11-10T16:30:00Z = 上海 2026-11-11 00:30
    const ms = Date.parse("2026-11-10T16:30:00.000Z")
    expect(shanghaiDate(String(ms))).toBe("2026-11-11")
    expect(shanghaiDate(ms)).toBe("2026-11-11")
    expect(sameDay(String(ms), "2026-11-11")).toBe(true)
    expect(sameDay(String(ms), "2026-11-10")).toBe(false)
  })

  it("10 位秒级时间戳也支持", () => {
    const seconds = Math.floor(Date.parse("2026-11-10T16:30:00.000Z") / 1000)
    expect(shanghaiDate(String(seconds))).toBe("2026-11-11")
  })

  it("ISO 8601 带 +08:00 时区", () => {
    expect(shanghaiDate("2026-11-10T00:00:00.000+08:00")).toBe("2026-11-10")
    expect(sameDay("2026-11-10", "2026-11-10T00:00:00.000+08:00")).toBe(true)
  })

  it("ISO 8601 带 Z 时区按上海换算（跨天）", () => {
    expect(shanghaiDate("2026-11-10T16:30:00.000Z")).toBe("2026-11-11")
    expect(sameDay("2026-11-11", "2026-11-10T16:30:00.000Z")).toBe(true)
  })

  it("空值/非法值不算相同", () => {
    expect(sameDay("", "")).toBe(false)
    expect(sameDay("不是日期", "2026-11-10")).toBe(false)
    expect(shanghaiDate("")).toBe("")
  })
})
