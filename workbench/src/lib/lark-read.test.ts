import { describe, expect, it } from "vitest"
import {
  attachmentKind,
  attachmentList,
  attachColumnName,
  buildRecordView,
  cellText,
  dateOnly,
  indexLocalRecords,
  rowsFingerprint,
} from "./lark-read"

describe("cellText", () => {
  it("字符串、数字原样，数组拼接，对象取 text", () => {
    expect(cellText("abc")).toBe("abc")
    expect(cellText(42)).toBe("42")
    expect(cellText(null)).toBe("")
    expect(cellText([{ text: "第一段" }, "第二段"])).toBe("第一段 第二段")
    expect(cellText({ text: "只有一段" })).toBe("只有一段")
    expect(cellText({ name: "选项" })).toBe("选项")
  })
})

describe("attachmentKind / attachmentList", () => {
  it("按扩展名区分图片和普通附件", () => {
    expect(attachmentKind("a.PNG")).toBe("image")
    expect(attachmentKind("a.jpeg")).toBe("image")
    expect(attachmentKind("a.pdf")).toBe("other")
    expect(attachmentKind("")).toBe("other")
  })

  it("没有 file_token 的项跳过", () => {
    expect(attachmentList([{ file_token: "t1", name: "a.png", size: 10 }, { name: "没有 token" }])).toEqual([
      { token: "t1", name: "a.png", size: 10, kind: "image" },
    ])
    expect(attachmentList(null)).toEqual([])
  })
})

describe("dateOnly", () => {
  it("ISO 带时区按 +08:00 换算", () => {
    expect(dateOnly("2026-11-10T00:00:00.000+08:00")).toBe("2026-11-10")
    expect(dateOnly("2026-11-09T16:30:00.000Z")).toBe("2026-11-10")
    expect(dateOnly("2026-11-10")).toBe("2026-11-10")
    expect(dateOnly("不是日期")).toBe("")
    expect(dateOnly(null)).toBe("")
  })
})

describe("buildRecordView", () => {
  const columns = ["问题名称", "创建时间", "客户公司1", "问题描述", "解决方案", "附件补充", "本地记录ID"]
  const columnNames = {
    title: "问题名称",
    date: "创建时间",
    customer: "客户公司1",
    problem: "问题描述",
    solution: "解决方案",
    attachment: "附件补充",
    local_id: "本地记录ID",
  }
  const localIndex = indexLocalRecords([
    { file: "x.md", localId: "AE-20261110-01", feishuRecordId: "recX", title: "t", date: "2026-11-10", chat: "客户：你好" },
  ])

  it("按配置的列名取字段，日期归一，附件带 kind", () => {
    const view = buildRecordView(
      {
        recordId: "recX",
        cells: ["标题", "2026-11-10T00:00:00.000+08:00", "示例客户", "描述", "", [{ file_token: "t1", name: "a.png" }], ""],
      },
      columns,
      columnNames,
      localIndex,
    )
    expect(view.title).toBe("标题")
    expect(view.date).toBe("2026-11-10")
    expect(view.problem).toBe("描述")
    expect(view.solution).toBe("")
    expect(view.attachments).toEqual([{ token: "t1", name: "a.png", size: 0, kind: "image" }])
  })

  it("配置里没有的列不报错，取不到就是空", () => {
    const view = buildRecordView({ recordId: "recY", cells: ["标题"] }, columns, { title: "问题名称" }, localIndex)
    expect(view.title).toBe("标题")
    expect(view.customer).toBe("")
    expect(view.attachments).toEqual([])
  })

  it("按本地记录ID 或飞书行 id 找到本地转写", () => {
    const byLocal = buildRecordView(
      { recordId: "recNope", cells: ["t", "", "", "", "", [], "AE-20261110-01"] },
      columns,
      columnNames,
      localIndex,
    )
    expect(byLocal.localTranscript).toBe("客户：你好")
    const byFeishu = buildRecordView({ recordId: "recX", cells: ["t"] }, columns, columnNames, localIndex)
    expect(byFeishu.localTranscript).toBe("客户：你好")
  })
})

describe("attachColumnName", () => {
  it("优先按附件字段类型找", () => {
    expect(
      attachColumnName([{ name: "附件补充", type: "attachment", options: 0 }], { attachment: "别的名字" }),
    ).toBe("附件补充")
  })
  it("没有类型信息时按配置名找，都找不到就报错", () => {
    expect(attachColumnName([{ name: "附件", type: "text", options: 0 }], { attachment: "附件" })).toBe("附件")
    expect(() => attachColumnName([{ name: "其他", type: "text", options: 0 }], {})).toThrow()
  })
})

describe("rowsFingerprint", () => {
  it("同一批行顺序不同指纹相同，内容变了指纹就变", () => {
    const a = [
      { recordId: "r1", cells: ["a"] },
      { recordId: "r2", cells: ["b"] },
    ]
    const b = [
      { recordId: "r2", cells: ["b"] },
      { recordId: "r1", cells: ["a"] },
    ]
    expect(rowsFingerprint(a)).toBe(rowsFingerprint(b))
    expect(rowsFingerprint(a)).not.toBe(rowsFingerprint([{ recordId: "r1", cells: ["a改"] }, b[0]]))
  })
})
