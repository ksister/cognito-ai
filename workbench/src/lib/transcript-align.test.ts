import { describe, expect, it } from "vitest"
import {
  alignTranscripts,
  countSpeakerDiffs,
  normalizeForAlign,
  normalizeSpeakerForCompare,
  sameSpeaker,
  textSimilarity,
  type AlignTurn,
} from "./transcript-align"

function t(speaker: string, text: string, kind: "speech" | "time" = "speech"): AlignTurn {
  return { speaker, text, kind }
}

describe("normalizeForAlign / textSimilarity", () => {
  it("去掉空白和标点", () => {
    expect(normalizeForAlign("读码率低，怎么办？")).toBe(normalizeForAlign("读码率低 怎么办"))
    expect(normalizeForAlign("V4.3 报错")).toBe("v43报错")
  })

  it("同一句话的相似度是 1，完全无关是低分", () => {
    expect(textSimilarity("读码率低", "读码率低。")).toBe(1)
    expect(textSimilarity("读码率低", "相机连不上")).toBeLessThan(0.6)
  })

  it("文字有一点点出入也能对上", () => {
    expect(textSimilarity("这个问题明天去现场看一下", "这个问题明天去现场看看")).toBeGreaterThanOrEqual(0.6)
  })
})

describe("发言人名字格式归一（避免误报发言人不同）", () => {
  it("空格、分隔符、全角半角、括号不同都算同一个人", () => {
    const variants = ["工作 宇创 张三", "工作-宇创-张三", "工作／宇创／张三", "【工作】宇创 张三", "工作　宇创　张三", "工作_宇创_张三"]
    const base = normalizeSpeakerForCompare(variants[0])
    for (const v of variants) expect(normalizeSpeakerForCompare(v)).toBe(base)
  })

  it("真不同的名字不会被当成一样", () => {
    expect(normalizeSpeakerForCompare("张三")).not.toBe(normalizeSpeakerForCompare("李四"))
    expect(normalizeSpeakerForCompare("我方同事")).not.toBe(normalizeSpeakerForCompare("张三"))
  })

  it("sameSpeaker 用归一后的名字比", () => {
    expect(sameSpeaker(t("工作 宇创 张三", "a"), t("工作-宇创-张三", "a"))).toBe(true)
    expect(sameSpeaker(t("工作 宇创 张三", "a"), t("工作 宇创 李四", "a"))).toBe(false)
  })

  it("对齐时同一名字的不同写法不算发言人不同（R060 的误报）", () => {
    const rows = alignTranscripts(
      [t("工作 宇创 张三", "闪退有哪天"), t("工作-宇创-张三", "今天下午")],
      [t("工作-宇创-张三", "闪退有哪天"), t("工作 宇创 张三", "今天下午")],
    )
    expect(rows.every((r) => !r.speakerDiff)).toBe(true)
  })
})

describe("alignTranscripts", () => {
  const a: AlignTurn[] = [t("客户甲", "读码率低"), t("我", "我看一下"), t("客户甲", "好的")]
  const b: AlignTurn[] = [t("客户甲", "读码率低"), t("客户甲", "我看一下"), t("客户甲", "好的")]

  it("同样的转写逐行对上，发言人不同会被标出来", () => {
    const rows = alignTranscripts(a, b)
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.speakerDiff)).toEqual([false, true, false])
    expect(countSpeakerDiffs(rows)).toBe(1)
  })

  it("文字有标点差异算同一句，不算发言人不同（归一化后文字相同）", () => {
    const rows = alignTranscripts([t("我", "我看一下")], [t("我", "我看一下。")])
    expect(rows).toHaveLength(1)
    expect(rows[0].speakerDiff).toBe(false)
    expect(rows[0].textDiff).toBe(false)
  })

  it("一边多出一行时，多出来的行单独成行", () => {
    const rows = alignTranscripts(a, [a[0], a[2]])
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.right === null)).toHaveLength(1)
    expect(rows.filter((r) => r.left === null)).toHaveLength(0)
    expect(countSpeakerDiffs(rows)).toBe(0)
  })

  it("空数组也能对齐", () => {
    expect(alignTranscripts([], [])).toEqual([])
    expect(alignTranscripts(a, [])).toHaveLength(3)
    expect(alignTranscripts([], b)).toHaveLength(3)
  })

  it("时间分隔行不参与发言人比较", () => {
    const rows = alignTranscripts(
      [t("", "—— 10月28日 09:12 ——", "time"), t("我", "好")],
      [t("", "—— 10月28日 09:12 ——", "time"), t("客户", "好")],
    )
    expect(rows[0].speakerDiff).toBe(false)
    expect(rows[1].speakerDiff).toBe(true)
  })

  it("顺序乱掉时不会整段错位（按 LCS 锚点对齐）", () => {
    const left = [t("我", "第一句"), t("客户", "第二句"), t("我", "第三句")]
    const right = [t("我", "第一句"), t("客户", "第三句")]
    const rows = alignTranscripts(left, right)
    // 「第三句」两边都在，但右边发言人是客户 → 应该被标出来
    const third = rows.find((r) => r.left?.text === "第三句")
    expect(third?.right?.text).toBe("第三句")
    expect(third?.speakerDiff).toBe(true)
  })

  it("两份转写完全不同时，各自单独成行、不算发言人不同", () => {
    const rows = alignTranscripts([t("我", "甲甲甲")], [t("客户", "乙乙乙")])
    expect(rows).toHaveLength(2)
    expect(rows.some((r) => r.left && r.right)).toBe(false)
    expect(rows.every((r) => !r.speakerDiff)).toBe(true)
  })

  it("同一句话在两边都出现多次时不会崩", () => {
    const x = [t("我", "好"), t("我", "好"), t("客户", "嗯")]
    const y = [t("客户", "好"), t("我", "好"), t("客户", "嗯")]
    const rows = alignTranscripts(x, y)
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(countSpeakerDiffs(rows)).toBeGreaterThanOrEqual(1)
  })
})
