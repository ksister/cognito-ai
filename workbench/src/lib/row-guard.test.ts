import { describe, expect, it } from "vitest"
import { checkTargetRow, sameDay } from "./row-guard"

const expected = { localId: "AE-20261110-01", title: "模板匹配耗时长、识别不准（取图）", date: "2026-11-10" }

describe("row-guard：更新飞书行之前的核对（T31）", () => {
  it("本地记录ID 一致且标题一致 → 允许更新", () => {
    expect(checkTargetRow(expected, { ...expected })).toEqual({ ok: true })
  })

  it("本地记录ID 一致、标题不同但日期一致 → 允许更新", () => {
    expect(
      checkTargetRow(expected, { localId: expected.localId, title: "标题被人工改过", date: "2026-11-10" }),
    ).toEqual({ ok: true })
  })

  it("飞书日期带时间也能按日期比对", () => {
    expect(
      checkTargetRow(expected, { localId: expected.localId, title: "别的标题", date: "2026-11-10T00:00:00.000+08:00" }),
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

  it("sameDay 只比日期部分，空值不算相同", () => {
    expect(sameDay("2026-11-10T00:00:00Z", "2026-11-10")).toBe(true)
    expect(sameDay("", "")).toBe(false)
    expect(sameDay("2026-11-10", "2026-11-11")).toBe(false)
  })
})
