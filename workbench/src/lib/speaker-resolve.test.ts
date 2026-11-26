import { describe, expect, it } from "vitest"
import {
  COLLEAGUE,
  isCompanyColleague,
  isGenericSpeaker,
  isMyNickname,
  isRealName,
  isSystemHintSpeaker,
  mergeQuoteTurns,
  namesFromWindowTitle,
  resolveAndFormat,
  resolveSpeakerTurns,
} from "./speaker-resolve"
import type { TranscriptTurn } from "./types"

const settings = { myNicknames: ["张三", "小张"], companyPrefixes: ["星图"] }

function t(over: Partial<TranscriptTurn>): TranscriptTurn {
  return { speaker: "", text: "", kind: "speech", ...over }
}

describe("泛称不算昵称", () => {
  it("「我」「客户」「对方」这些不算身份", () => {
    for (const name of ["我", "客户", "对方", "本人", "自己", "  "]) {
      expect(isGenericSpeaker(name)).toBe(true)
      expect(isRealName(name, settings)).toBe(false)
    }
  })

  it("泛称不会命中「我的昵称」，哪怕用户把「我」留在列表里", () => {
    const withGeneric = { myNicknames: ["我", "张三"], companyPrefixes: [] }
    expect(isMyNickname("我", withGeneric)).toBe(false)
    expect(isMyNickname("张三", withGeneric)).toBe(true)
  })

  it("真名算身份（去掉公司前缀后比）", () => {
    expect(isRealName("李四", settings)).toBe(true)
    expect(isRealName("星图_李四", settings)).toBe(true)
    expect(isMyNickname("星图_张三", settings)).toBe(true)
  })
})

describe("resolveSpeakerTurns（真名优先，其次气泡）", () => {
  it("右侧：没名字/泛称是我；真名不是我时保留原名（并标 uncertain）", () => {
    const { turns } = resolveSpeakerTurns(
      [
        t({ text: "a", side: "right" }),
        t({ text: "b", side: "right", speaker: "对方" }),
        t({ text: "c", side: "right", speaker: "张三" }),
        t({ text: "d", side: "right", speaker: "李四" }),
      ],
      settings,
    )
    expect(turns.map((x) => x.speaker)).toEqual(["我", "我", "我", "李四"])
  })

  it("左侧是客户：真名保留，泛称/空写「客户」", () => {
    const { turns } = resolveSpeakerTurns(
      [
        t({ text: "a", side: "left" }),
        t({ text: "b", side: "left", speaker: "客户" }),
        t({ text: "c", side: "left", speaker: "李四" }),
      ],
      settings,
    )
    expect(turns.map((x) => x.speaker)).toEqual(["客户", "客户", "李四"])
  })

  it("真名命中「我的昵称」、气泡在左侧 → 仍然是「我」（飞书/钉钉靠左布局）", () => {
    const out = resolveSpeakerTurns([t({ text: "a", side: "left", speaker: "张三" })], settings)
    expect(out.turns[0].speaker).toBe("我")
    // 带公司前缀的也算命中
    const out2 = resolveSpeakerTurns([t({ text: "b", side: "left", speaker: "星图_张三" })], settings)
    expect(out2.turns[0].speaker).toBe("我")
  })

  it("昵称不是我方但气泡在右：保持原样并标 uncertain", () => {
    const out = resolveSpeakerTurns([t({ text: "a", side: "right", speaker: "李四" })], settings)
    expect(out.turns[0].speaker).toBe("李四")
    expect(out.uncertain.join("")).toContain("气泡在右侧")
  })

  it("没有侧别时才只看真名昵称：命中我的是我，别人保留昵称", () => {
    const out = resolveSpeakerTurns([t({ text: "a", speaker: "张三" }), t({ text: "b", speaker: "李四" })], settings)
    expect(out.turns.map((x) => x.speaker)).toEqual(["我", "李四"])
    expect(out.uncertain.join("")).toContain("读不出气泡左右")
  })

  it("没有侧别、没有昵称、只有泛称：标未知", () => {
    const out = resolveSpeakerTurns([t({ text: "a" }), t({ text: "b", speaker: "对方" })], settings)
    expect(out.turns.map((x) => x.speaker)).toEqual(["未知", "未知"])
    expect(out.uncertain.join("")).toContain("未知")
  })

  it("用户把「我」从昵称列表删掉后，右侧照样是我（不靠列表）", () => {
    const noMine = { myNicknames: [], companyPrefixes: [] }
    const out = resolveSpeakerTurns([t({ text: "a", side: "right" }), t({ text: "b", side: "left", speaker: "李四" })], noMine)
    expect(out.turns.map((x) => x.speaker)).toEqual(["我", "李四"])
    expect(out.uncertain).toEqual([])
  })

  it("时间分隔行不参与判断", () => {
    const turn = t({ text: "—— 10月28日 09:12 ——", kind: "time" })
    expect(resolveSpeakerTurns([turn], settings).turns[0]).toEqual(turn)
  })

  it("只改发言人，不改文字", () => {
    const { turns } = resolveSpeakerTurns([t({ text: "型号 ABC-1 报错", side: "left", speaker: "李四" })], settings)
    expect(turns[0].text).toBe("型号 ABC-1 报错")
  })
})

describe("我方同事（名字带公司前缀、但不是我）", () => {
  it("识别：带我方前缀的真名算同事，我自己、客户名、泛称都不算", () => {
    expect(isCompanyColleague("星图_李四", settings)).toBe(true)
    expect(isCompanyColleague("星图 王五", settings)).toBe(true)
    expect(isCompanyColleague("星图-赵六", settings)).toBe(true)
    expect(isCompanyColleague("星图_张三", settings)).toBe(false) // 是我
    expect(isCompanyColleague("李四", settings)).toBe(false) // 客户，没前缀
    expect(isCompanyColleague("星图_客户", settings)).toBe(false) // 泛称
    expect(isCompanyColleague("", settings)).toBe(false)
  })

  it("左侧的同事标成「我方同事」，不归客户方（同事给的方法不能被当成客户说的）", () => {
    const { turns, uncertain } = resolveSpeakerTurns(
      [
        t({ text: "建议先看日志", speaker: "星图_李四", side: "left" }),
        t({ text: "日志在哪", speaker: "客户甲", side: "left" }),
      ],
      settings,
    )
    expect(turns[0].speaker).toBe(COLLEAGUE)
    expect(turns[1].speaker).toBe("客户甲")
    expect(uncertain.join("")).toContain("我方公司前缀")
  })

  it("右侧的同事也标成「我方同事」（不按气泡把他算成客户或我）", () => {
    const { turns } = resolveSpeakerTurns([t({ text: "我来处理", speaker: "星图_李四", side: "right" })], settings)
    expect(turns[0].speaker).toBe(COLLEAGUE)
  })

  it("没有侧别信息时，同事仍按名字认出来", () => {
    const { turns } = resolveSpeakerTurns([t({ text: "看一下", speaker: "星图_李四" })], settings)
    expect(turns[0].speaker).toBe(COLLEAGUE)
  })

  it("转写格式里显示「我方同事：…」", () => {
    const { chat } = resolveAndFormat([t({ text: "先重启试试", speaker: "星图_李四", side: "left" })], settings)
    expect(chat).toContain("我方同事：先重启试试")
  })

  it("前缀配置为空时不会误判同事", () => {
    const noPrefix = { myNicknames: ["张三"], companyPrefixes: [] }
    expect(isCompanyColleague("星图_李四", noPrefix)).toBe(false)
  })
})

describe("resolveAndFormat", () => {
  it("输出带 OCR 标记的原始聊天记录格式", () => {
    const { chat } = resolveAndFormat(
      [
        t({ text: "—— 10月28日 09:12 ——", kind: "time" }),
        t({ text: "读码率低", speaker: "李四", side: "left" }),
        t({ text: "我看一下", side: "right" }),
      ],
      settings,
    )
    expect(chat.split("\n")[0]).toBe("[OCR 转写，以截图为准]")
    expect(chat).toContain("李四：读码率低")
    expect(chat).toContain("我：我看一下")
    expect(chat).toContain("—— 10月28日 09:12 ——")
  })
})

describe("引用识别（系统提示 + 「名字：内容」）", () => {
  it("认得「系统提示」这类发言人", () => {
    for (const name of ["系统提示", "系统消息", "系统", "提示"]) expect(isSystemHintSpeaker(name)).toBe(true)
    expect(isSystemHintSpeaker("张三")).toBe(false)
    expect(isSystemHintSpeaker("")).toBe(false)
  })

  it("名字在本条聊天里出现过 → 并进前一条，不单独成行", () => {
    const out = mergeQuoteTurns(
      [
        t({ speaker: "客户甲", text: "读码率低", side: "left" }),
        t({ speaker: "系统提示", text: "客户甲：之前说的那个版本不行" }),
      ],
      [],
    )
    expect(out.quotes).toBe(1)
    expect(out.turns).toHaveLength(1)
    expect(out.turns[0].text).toBe("读码率低（引用 客户甲：之前说的那个版本不行）")
  })

  it("我的昵称（extraNames）也算出现过", () => {
    const out = mergeQuoteTurns(
      [
        t({ speaker: "客户甲", text: "什么时候能好", side: "left" }),
        t({ speaker: "系统提示", text: "张珂：我看一下日志" }),
      ],
      ["张珂"],
    )
    expect(out.quotes).toBe(1)
    expect(out.turns[0].text).toContain("（引用 张珂：我看一下日志）")
  })

  it("引用的名字带公司/标签前缀也算出现过（后缀匹配）", () => {
    const out = mergeQuoteTurns(
      [
        t({ speaker: "李四", text: "什么时候能好", side: "left" }),
        t({ speaker: "系统提示", text: "工作 宇创 李四：我看一下日志" }),
      ],
      [],
    )
    expect(out.quotes).toBe(1)
    expect(out.turns[0].text).toContain("（引用 工作 宇创 李四：我看一下日志）")
  })

  it("单聊里引用对方的话也能认出来（窗口标题里的人名算「见过」）", () => {
    const title = namesFromWindowTitle("工作 宇创 魏笑凡")
    expect(title.some((n) => n.includes("魏笑凡"))).toBe(true)
    const out = resolveSpeakerTurns(
      [
        t({ speaker: "客户", text: "这个版本什么时候能好", side: "left" }),
        t({ speaker: "系统提示", text: "魏笑凡：上周说的那个补丁不管用" }),
      ],
      settings,
      title,
    )
    expect(out.quotes).toBe(1)
    expect(out.turns[0].text).toContain("（引用 魏笑凡：上周说的那个补丁不管用）")
  })

  it("窗口标题的人名带公司/标签前缀也能后缀匹配", () => {
    const title = namesFromWindowTitle("工作 宇创 魏笑凡")
    const out = mergeQuoteTurns(
      [
        t({ speaker: "客户", text: "好", side: "left" }),
        t({ speaker: "系统提示", text: "工作 宇创 魏笑凡：再确认下" }),
      ],
      title,
    )
    expect(out.quotes).toBe(1)
  })

  it("窗口标题里的人数括号、业务词不会当成名字", () => {
    const names = namesFromWindowTitle("魏笑凡(3) 星图技术支持")
    expect(names).toContain("魏笑凡")
    expect(names.some((n) => n === "技术支持")).toBe(false)
    expect(namesFromWindowTitle("")).toEqual([])
  })

  it("名字没见过 → 保留原样，不当引用", () => {
    const out = mergeQuoteTurns(
      [
        t({ speaker: "客户甲", text: "读码率低", side: "left" }),
        t({ speaker: "系统提示", text: "陌生人：这句话不是引用" }),
      ],
      [],
    )
    expect(out.quotes).toBe(0)
    expect(out.turns).toHaveLength(2)
  })

  it("没有「名字：内容」形状的系统提示也不动", () => {
    const out = mergeQuoteTurns([t({ speaker: "系统提示", text: "以下是引用内容" })], [])
    expect(out.quotes).toBe(0)
    expect(out.turns).toHaveLength(1)
  })

  it("引用前面只有时间分隔行时，挂到更早的那条发言上", () => {
    const out = mergeQuoteTurns(
      [
        t({ speaker: "客户甲", text: "读码率低", side: "left" }),
        t({ text: "—— 10月28日 09:12 ——", kind: "time" }),
        t({ speaker: "系统提示", text: "客户甲：你好" }),
      ],
      [],
    )
    expect(out.quotes).toBe(1)
    expect(out.turns[0].text).toContain("（引用 客户甲：你好）")
    expect(out.turns[1].kind).toBe("time")
  })

  it("resolveSpeakerTurns 会先并引用，再判发言人，并回报引用条数", () => {
    const out = resolveSpeakerTurns(
      [
        t({ speaker: "客户甲", text: "读码率低", side: "left" }),
        t({ speaker: "系统提示", text: "客户甲：之前说的版本不行" }),
      ],
      settings,
    )
    expect(out.quotes).toBe(1)
    expect(out.turns).toHaveLength(1)
    expect(out.turns[0].speaker).toBe("客户甲")
    expect(out.turns[0].text).toContain("（引用 客户甲：之前说的版本不行）")
  })

  it("转写格式里引用不单独成行", () => {
    const { chat } = resolveAndFormat(
      [
        t({ speaker: "客户甲", text: "读码率低", side: "left" }),
        t({ speaker: "系统提示", text: "客户甲：之前说的那个版本不行" }),
      ],
      settings,
    )
    expect(chat).toContain("客户甲：读码率低（引用 客户甲：之前说的那个版本不行）")
    expect(chat.split("\n").filter((l) => l.includes("系统提示"))).toHaveLength(0)
  })
})
