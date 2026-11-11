import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parseFeishuTableSchema, schemaPasteCells, type FeishuTableSchema } from "./feishu-schema"
import { toTsvRows } from "./feishu"
import {
  columnsDroppedByView,
  hiddenSchemaColumns,
  pasteCellsForView,
  placeholderViewColumns,
  viewColumnNames,
  viewPasteWarnings,
} from "./paste-view"
import { emptyDraft, type SupportRecord } from "./types"

const examplePath = path.join(process.cwd(), "config", "feishu-table.example.json")
const example = parseFeishuTableSchema(JSON.parse(readFileSync(examplePath, "utf8")), examplePath)

function record(patch: Partial<SupportRecord> = {}): SupportRecord {
  return {
    ...emptyDraft("示例-星河电子"),
    ...patch,
    extras: { ...(patch.extras ?? {}) },
    id: "示例-星河电子/2026-10-15-demo",
    file: "2026-10-15-demo.md",
    feishuSynced: false,
    feishuRecordId: "",
    feishuSyncedAt: "",
    feishuAttached: [],
    created: "2026-10-15T00:00:00.000Z",
    updated: "2026-10-15T00:00:00.000Z",
  }
}

const filled = record({
  title: "手机中框读码率低",
  contact: "王工",
  site: "示例产线",
  problem: "现象",
  solution: "方案",
  status: "已解决",
  customer: "示例-星河电子",
})

describe("paste-view：按视图可见列顺序排列（T16）", () => {
  it("按视图顺序输出，工作台不认识的列留空占位", () => {
    const names = example.columns.map((c) => c.name)
    const r = record({ title: "标题A", contact: "联系人B" })
    const view = [names[3], "字段 1", names[0]]
    const cells = pasteCellsForView(view, example, r)
    expect(cells).toHaveLength(3)
    expect(cells[1]).toBe("")
    expect(cells[0]).toBe(String(r.contact ?? ""))
    expect(cells[2]).toBe("标题A")
  })

  it("列数正好等于视图可见列数（多一个会让飞书新建字段）", () => {
    const view = example.columns.map((c) => c.name)
    expect(pasteCellsForView(view, example, filled)).toHaveLength(view.length)
  })

  it("同一批值在不同视图顺序下落到不同位置", () => {
    const a = example.columns[0].name
    const b = example.columns[1].name
    const forward = pasteCellsForView([a, b], example, filled)
    const backward = pasteCellsForView([b, a], example, filled)
    expect(forward[0]).toBe(backward[1])
    expect(forward[1]).toBe(backward[0])
  })

  it("视图列名两端的空格不影响匹配", () => {
    const name = example.columns[3].name
    expect(pasteCellsForView([` ${name} `], example, filled)[0]).toBe(schemaPasteCells(example, filled)[3])
  })
})

describe("paste-view：占位与隐藏列提示", () => {
  const schemaWithPlaceholders: FeishuTableSchema = {
    version: 1,
    multiSeparator: ",",
    columns: [
      { name: "标题", type: "text", key: "title", extract: true, options: [], multiline: false, onUnmatched: "skip" },
      { name: "附件", type: "attachment", extract: false, options: [], multiline: false, onUnmatched: "skip" },
      { name: "处理人", type: "person", extract: false, options: [], multiline: false, onUnmatched: "skip" },
      { name: "备注", type: "text", key: "notes", extract: true, options: [], multiline: false, onUnmatched: "skip" },
    ],
  }

  it("人员、附件列输出空占位", () => {
    const cells = pasteCellsForView(["标题", "附件", "处理人", "备注"], schemaWithPlaceholders, record({ title: "t" }))
    expect(cells[0]).toBe("t")
    expect(cells[1]).toBe("")
    expect(cells[2]).toBe("")
  })

  it("placeholderViewColumns 只算工作台不填的列", () => {
    expect(placeholderViewColumns(["标题", "附件", "处理人", "备注", "字段 1"], schemaWithPlaceholders)).toEqual([
      "附件",
      "处理人",
      "字段 1",
    ])
  })

  it("工作台会填、被视图隐藏且确实有内容的列要提示", () => {
    const r = record({ title: "t", extras: { notes: "备注内容" } })
    const dropped = columnsDroppedByView(["标题"], schemaWithPlaceholders, r)
    expect(dropped).toContain("备注")
    expect(dropped).not.toContain("标题")
    const warning = viewPasteWarnings(["标题"], schemaWithPlaceholders, r)
    expect(warning[0]).toContain("隐藏了")
    expect(warning[0]).toContain("备注")
  })

  it("隐藏列本来就没内容时不提示", () => {
    expect(columnsDroppedByView(["标题", "备注"], schemaWithPlaceholders, record({ title: "t" }))).toEqual([])
    expect(viewPasteWarnings(["标题", "备注"], schemaWithPlaceholders, record({ title: "t" }))).toEqual([])
  })

  it("人员/附件被隐藏不算丢内容", () => {
    const dropped = columnsDroppedByView(["标题", "备注"], schemaWithPlaceholders, record({ title: "t", extras: {} }))
    expect(dropped).not.toContain("附件")
    expect(dropped).not.toContain("处理人")
  })

  it("hiddenSchemaColumns 与记录无关，只看配置和视图", () => {
    expect(hiddenSchemaColumns(["标题"], schemaWithPlaceholders)).toEqual(["备注"])
  })
})

describe("paste-view：TSV 与回退", () => {
  it("没有视图时按 feishu-table.json 的列顺序（旧行为）", () => {
    const text = toTsvRows([filled], example, false, null)
    expect(text).toBe(schemaPasteCells(example, filled).join("\t"))
  })

  it("有视图时制表符数量 = 可见列数 - 1，表头用视图列名", () => {
    const view = { name: "测试视图", columns: [{ name: example.columns[2].name }, { name: "字段 1" }] }
    const row = toTsvRows([filled], example, false, view)
    expect(row.split("\t")).toHaveLength(2)
    const header = toTsvRows([filled], example, true, view).split("\n")[0]
    expect(header).toBe([example.columns[2].name, "字段 1"].join("\t"))
  })

  it("viewColumnNames 同时接受字符串和对象", () => {
    expect(viewColumnNames(["A", { name: "B" }])).toEqual(["A", "B"])
  })

  it("多行记录对应多行 TSV，每行列数一致", () => {
    const view = { name: "v", columns: [{ name: example.columns[0].name }, { name: example.columns[1].name }] }
    const text = toTsvRows([filled, filled], example, false, view)
    const lines = text.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0].split("\t")).toHaveLength(2)
    expect(lines[1].split("\t")).toHaveLength(2)
  })
})
