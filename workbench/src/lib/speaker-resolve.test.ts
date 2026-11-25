import { describe, expect, it } from "vitest"
import { isMyNickname, resolveAndFormat, resolveSpeakerTurns } from "./speaker-resolve"
import type { TranscriptTurn } from "./types"

const settings = { myNicknames: ["张三", "小张"], companyPrefixes: ["星图"] }

function t(over: Partial<TranscriptTurn>): TranscriptTurn {
  return { speaker: "", text: "", kind: "speech", ...over }
}

describe("isMyNickname", () => {
  it("昵称命中（忽略我方公司前缀）", () => {
    expect(isMyNickname("张三", settings)).toBe(true)
    expect(isMyNickname("星图_张三", settings)).toBe(true)
    expect(isMyNickname("星图 小张", settings)).toBe(true)
  })

  it("客户昵称不算我", () => {
    expect(isMyNickname("李四", settings)).toBe(false)
    expect(isMyNickname("", settings)).toBe(false)
  })

  it("前缀配置为空时只做原样比较", () => {
    expect(isMyNickname("星图_张三", { myNicknames: ["张三"], companyPrefixes: [] })).toBe(false)
    expect(isMyNickname("张三", { myNicknames: ["张三"], companyPrefixes: [] })).toBe(true)
  })
})

describe("resolveSpeakerTurns", () => {
  it("右侧的气泡 = 我（截图没显示昵称也一样）", () => {
    const { turns } = resolveSpeakerTurns([t({ text: "你好", side: "right" })], settings)
    expect(turns[0].speaker).toBe("我")
  })

  it("左侧的气泡 = 客户，有昵称就保留昵称（R153/R154 要的效果）", () => {
    const { turns } = resolveSpeakerTurns(
      [t({ text: "你好", side: "left" }), t({ text: "在吗", speaker: "李四", side: "left" })],
      settings,
    )
    expect(turns[0].speaker).toBe("客户")
    expect(turns[1].speaker).toBe("李四")
  })

  it("客户名字在左侧，不会被改成我（哪怕它在右边？不，右侧才是）", () => {
    const { turns } = resolveSpeakerTurns([t({ text: "日志在哪", speaker: "李四", side: "left" })], settings)
    expect(turns[0].speaker).toBe("李四")
  })

  it("昵称命中「我的昵称」时，即使在左侧也算我（截图昵称是可靠信号）", () => {
    const { turns } = resolveSpeakerTurns([t({ text: "我发的", speaker: "张三", side: "left" })], settings)
    expect(turns[0].speaker).toBe("我")
  })

  it("右侧但昵称不在配置里：仍算我，并提示去设置页核对", () => {
    const out = resolveSpeakerTurns([t({ text: "a", speaker: "王五", side: "right" })], settings)
    expect(out.turns[0].speaker).toBe("我")
    expect(out.uncertain.join("")).toContain("不在设置页的「我的昵称」里")
  })

  it("没有气泡位置也没有昵称：标未知并写 uncertain", () => {
    const out = resolveSpeakerTurns([t({ text: "a" })], settings)
    expect(out.turns[0].speaker).toBe("未知")
    expect(out.uncertain.join("")).toContain("未知")
  })

  it("没有气泡位置但有昵称：保留昵称", () => {
    const { turns } = resolveSpeakerTurns([t({ text: "a", speaker: "李四" })], settings)
    expect(turns[0].speaker).toBe("李四")
  })

  it("时间分隔行不参与判断，原样保留", () => {
    const turn = t({ text: "—— 10月28日 09:12 ——", kind: "time" })
    const { turns } = resolveSpeakerTurns([turn], settings)
    expect(turns[0]).toEqual(turn)
  })

  it("只改发言人，不改文字", () => {
    const { turns } = resolveSpeakerTurns([t({ text: "型号 ABC-1 报错", side: "left", speaker: "李四" })], settings)
    expect(turns[0].text).toBe("型号 ABC-1 报错")
  })

  it("没有昵称配置时也能按侧边跑", () => {
    const { turns } = resolveSpeakerTurns(
      [t({ text: "a", side: "right" }), t({ text: "b", side: "left" })],
      { myNicknames: [], companyPrefixes: [] },
    )
    expect(turns.map((x) => x.speaker)).toEqual(["我", "客户"])
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
