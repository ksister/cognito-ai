import { describe, expect, it } from "vitest"
import { changedFieldLabels, mergeReorganizedDraft } from "./reorganize"
import { emptyDraft } from "./types"

function base() {
  const d = emptyDraft("锴士")
  return {
    ...d,
    title: "平面拟合后Z偏移",
    customer: "",
    product: "4.4.5",
    problem: "原始问题描述",
    solution: "原始方案",
    chat: "[OCR 转写，以截图为准]\nLucas：问题A",
    thoughts: "我的思考原文",
    uncertain: ["客户身份未明确"],
  }
}

describe("mergeReorganizedDraft", () => {
  it("空值不覆盖用户手动选的值（软件版本保留）", () => {
    const b = base()
    const merged = mergeReorganizedDraft(b, { product: "", problem: "" })
    expect(merged.product).toBe("4.4.5")
    expect(merged.problem).toBe("原始问题描述")
  })

  it("模型给了新客户名就覆盖", () => {
    const b = base()
    const merged = mergeReorganizedDraft(b, { customer: "镭创" })
    expect(merged.customer).toBe("镭创")
  })

  it("空数组不覆盖已有的多选值", () => {
    const b = { ...base(), dimensions: ["3D"] }
    const merged = mergeReorganizedDraft(b, { dimensions: [] })
    expect(merged.dimensions).toEqual(["3D"])
  })

  it("uncertain 直接用新结果（包括清空）", () => {
    const b = base()
    const merged = mergeReorganizedDraft(b, { uncertain: [] })
    expect(merged.uncertain).toEqual([])
  })

  it("chat 和我的思考任何情况下都不变", () => {
    const b = base()
    const merged = mergeReorganizedDraft(b, { chat: "被模型改掉的转写", thoughts: "被模型改掉的思考" })
    expect(merged.chat).toBe(b.chat)
    expect(merged.thoughts).toBe(b.thoughts)
  })
})

describe("changedFieldLabels", () => {
  it("只列出真正变化的字段", () => {
    const b = base()
    const merged = mergeReorganizedDraft(b, { customer: "镭创", problem: "新问题" })
    const labels = changedFieldLabels(b, merged)
    expect(labels).toContain("客户")
    expect(labels).toContain("问题描述")
    expect(labels).not.toContain("软件版本")
    expect(labels).not.toContain("解决方案")
  })
})
