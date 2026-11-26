import { describe, expect, it } from "vitest"
import {
  buildBubbleItems,
  parseCitationFromText,
  quoteFoundInEarlier,
  similarText,
  summarizeBubbles,
  type BubbleInputTurn,
} from "./chat-bubble-view"

function t(over: Partial<BubbleInputTurn>): BubbleInputTurn {
  return { speaker: "", text: "", kind: "speech", ...over }
}

describe("buildBubbleItems", () => {
  it("按发言人分气泡类型：我在右、客户在左、同事带标签、时间居中", () => {
    const items = buildBubbleItems([
      t({ kind: "time", text: "—— 10月28日 09:12 ——" }),
      t({ speaker: "我", text: "我看一下" }),
      t({ speaker: "客户甲", text: "读码率低" }),
      t({ speaker: "我方同事", text: "我先看" }),
      t({ speaker: "系统提示", text: "系统提示" }),
    ])
    expect(items.map((i) => i.kind)).toEqual(["time", "speech", "speech", "speech", "speech"])
    // 行号只数发言行，时间行是 0
    expect(items.map((i) => i.line)).toEqual([0, 1, 2, 3, 4])
    expect(items[1].variant).toBe("me")
    expect(items[2].variant).toBe("other")
    expect(items[3].variant).toBe("colleague")
    expect(items[4].variant).toBe("system")
  })

  it("标记会替换显示值，并记下标记类型", () => {
    const items = buildBubbleItems([t({ speaker: "客户甲", text: "读码率低" })], [
      { line: 1, type: "speaker", originalSpeaker: "客户甲", originalText: "读码率低", newSpeaker: "我" },
    ])
    expect(items[0].displaySpeaker).toBe("我")
    expect(items[0].originalSpeaker).toBe("客户甲")
    expect(items[0].markedTypes).toEqual(["speaker"])
  })

  it("引用内容能在前面找到原话 → quoteVerified=true；找不到 → false 并进待核对", () => {
    const item = buildBubbleItems([
      t({ speaker: "客户甲", text: "读码率低，帮我看看" }),
      t({ speaker: "我", text: "收到（引用 客户甲：读码率低，帮我看看）", quote: { name: "客户甲", text: "读码率低，帮我看看" } }),
    ])[1]
    expect(item.quoteVerified).toBe(true)
    const missing = buildBubbleItems([
      t({ speaker: "我", text: "好", quote: { name: "客户甲", text: "这句话根本前面没有" } }),
    ])[0]
    expect(missing.quoteVerified).toBe(false)
    expect(summarizeBubbles([missing]).pending).toEqual([{ line: 1, reason: "quote-missing" }])
  })

  it("飞书回复没拆出引用的行 → 待核对", () => {
    const items = buildBubbleItems([t({ speaker: "我", text: "|回复 张珂：被引用的话 还有log" })])
    expect(items[0].replyUnsplit).toBe(true)
    expect(summarizeBubbles(items).pending).toEqual([{ line: 1, reason: "reply-unsplit" }])
  })

  it("标记对不上当前转写（重判过）→ 不显示红点，只计数", () => {
    const items = buildBubbleItems([t({ speaker: "客户甲", text: "读码率低，帮我看看" })], [
      { line: 1, type: "speaker", originalSpeaker: "客户甲", originalText: "旧文本不一样", newSpeaker: "我" },
    ])
    expect(items[0].markedTypes).toEqual([])
    expect(items[0].staleMarkCount).toBe(1)
    expect(summarizeBubbles(items).staleMarks).toBe(1)
  })

  it("文字只有标点/空格差别时，标记仍然对得上", () => {
    const items = buildBubbleItems([t({ speaker: "客户甲", text: "读码率低，帮我看看。" })], [
      { line: 1, type: "text", originalSpeaker: "客户甲", originalText: "读码率低 帮我看看", newText: "读码率偏低" },
    ])
    expect(items[0].markedTypes).toEqual(["text"])
    expect(items[0].staleMarkCount).toBe(0)
    expect(items[0].displayText).toBe("读码率偏低")
  })

  it("真实结果文件结构：带 quote 字段的，气泡下面能显示引用", () => {
    const items = buildBubbleItems([
      t({ speaker: "客户", text: "指的是扫描长度不够", rawSpeaker: "工作 镭创 吕忠维" }),
      t({
        speaker: "我",
        text: "这个也有（引用 客户：指的是扫描长度不够）",
        quote: { name: "客户", text: "指的是扫描长度不够", source: "name" },
      }),
    ])
    expect(items[1].quote).not.toBeNull()
    expect(items[1].displayText).toBe("这个也有")
    expect(items[1].quoteDisplayName).toBe("工作 镭创 吕忠维")
  })

  it("旧结果（只有正文拼接、没有 quote 字段）也要把引用解析出来", () => {
    const items = buildBubbleItems([
      t({ speaker: "我", text: "这个也有（引用 客户：指的是扫描长度不够）" }),
      t({ speaker: "客户", text: "这个取图时间多少（引用 我：这个也有）" }),
    ])
    expect(items[0].quote).toMatchObject({ name: "客户", text: "指的是扫描长度不够" })
    expect(items[0].displayText).toBe("这个也有")
    expect(items[1].quote).toMatchObject({ name: "我", text: "这个也有" })
    expect(items[1].displayText).toBe("这个取图时间多少")
  })

  it("parseCitationFromText 处理带括号的引用内容", () => {
    const q = parseCitationFromText("收到（引用 客户：先看 A（B）再说）")
    expect(q).toEqual({ name: "客户", text: "先看 A（B）再说" })
    expect(parseCitationFromText("没有引用的一句话")).toBeNull()
  })

  it("「不是引用」标记会计入统计", () => {
    const text = "好（引用 客户甲：读码率低）"
    const items = buildBubbleItems([t({ speaker: "我", text, quote: { name: "客户甲", text: "读码率低" } })], [
      { line: 1, type: "unquote", originalSpeaker: "我", originalText: text },
    ])
    expect(items[0].markedTypes).toEqual(["unquote"])
    expect(summarizeBubbles(items).unquoteMarked).toBe(1)
  })

  it("气泡里不显示拼在正文里的「（引用 …）」，引用单独一行；名字用截图原始名字", () => {
    const items = buildBubbleItems([
      t({ speaker: "客户", text: "主要是考虑拼接完的效果", rawSpeaker: "魏笑凡" }),
      t({
        speaker: "我",
        text: "收到（引用 客户：主要是考虑拼接完的效果）",
        quote: { name: "客户", text: "主要是考虑拼接完的效果" },
      }),
    ])
    expect(items[1].displayText).toBe("收到")
    expect(items[0].quote).toBeNull()
    expect(items[1].quoteDisplayName).toBe("魏笑凡")
  })

  it("引用名字本来就是真名时原样显示", () => {
    const items = buildBubbleItems([
      t({ speaker: "我", text: "好（引用 张珂：明天给你）", quote: { name: "张珂", text: "明天给你" } }),
    ])
    expect(items[0].quoteDisplayName).toBe("张珂")
  })
})

describe("summarizeBubbles", () => {
  it("统计四类标记数量", () => {
    const stats = summarizeBubbles(
      buildBubbleItems(
        [t({ speaker: "我", text: "a" }), t({ speaker: "客户甲", text: "b" }), t({ speaker: "客户甲", text: "c" })],
        [
          { line: 1, type: "speaker", originalSpeaker: "我", originalText: "a", newSpeaker: "客户" },
          { line: 2, type: "text", originalSpeaker: "客户甲", originalText: "b", newText: "b2" },
          { line: 2, type: "extra", originalSpeaker: "客户甲", originalText: "b" },
          { line: 3, type: "quote", originalSpeaker: "客户甲", originalText: "c" },
        ],
      ),
    )
    expect(stats.speakerChanged).toBe(1)
    expect(stats.textChanged).toBe(1)
    expect(stats.extraMarked).toBe(1)
    expect(stats.quoteMarked).toBe(1)
  })
})

describe("quoteFoundInEarlier / similarText", () => {
  it("整句或前缀都能匹配", () => {
    expect(quoteFoundInEarlier(["这个问题明天去现场看一下相机参数"], "这个问题明天去现场看一下相机参数")).toBe(true)
    expect(quoteFoundInEarlier(["这个问题明天去现场看一下相机参数再调曝光"], "这个问题明天去现场看一下相机参数")).toBe(true)
    expect(quoteFoundInEarlier(["完全无关的一句话"], "这个问题明天去现场看一下相机参数")).toBe(false)
    expect(similarText("读码率低。", "读码率低")).toBe(1)
  })
})
