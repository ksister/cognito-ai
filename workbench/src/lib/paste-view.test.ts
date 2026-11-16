import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parseFeishuTableSchema, schemaPasteCells, type FeishuTableSchema } from "./feishu-schema"
import { toTsvRows } from "./feishu"
import {
  cacheFallbackNotice,
  columnsDroppedByView,
  configFallbackNotice,
  copySuccessNotice,
  hiddenSchemaColumns,
  parsePasteViewConfigText,
  pasteCellsForView,
  placeholderViewColumns,
  resolvePasteColumns,
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

describe("paste-view：复制时的三级兜底（评审补充）", () => {
  const cached = { columns: ["客户公司1", "问题名称"], readAt: "2026-11-12" }

  it("现场读得到：用现场列序", () => {
    const r = resolvePasteColumns({ viewName: "客户问题支持记录表", live: ["问题名称", "客户公司1"], cached })
    expect(r.source).toBe("live")
    if (r.source === "config") throw new Error("should be live")
    expect(r.columns).toEqual(["问题名称", "客户公司1"])
  })

  it("现场读不到但有缓存：用缓存列序并带读取日期", () => {
    const r = resolvePasteColumns({ viewName: "客户问题支持记录表", live: null, cached })
    expect(r.source).toBe("cache")
    if (r.source !== "cache") throw new Error("should be cache")
    expect(r.columns).toEqual(["客户公司1", "问题名称"])
    expect(r.readAt).toBe("2026-11-12")
  })

  it("现场读不到且没有缓存：退回配置列序", () => {
    const r = resolvePasteColumns({ viewName: "客户问题支持记录表", live: null, cached: null })
    expect(r.source).toBe("config")
    expect(r).not.toHaveProperty("columns")
  })

  it("读取返回空数组也算读不到，继续走缓存", () => {
    const r = resolvePasteColumns({ viewName: "v", live: [], cached })
    expect(r.source).toBe("cache")
  })

  it("缓存提示写明日期、视图名，并要求核对", () => {
    const text = cacheFallbackNotice("客户问题支持记录表", "2026-11-12")
    expect(text).toContain("飞书暂时读不到")
    expect(text).toContain("11-12")
    expect(text).toContain("客户问题支持记录表")
    expect(text).toContain("核对")
  })

  it("配置列序兜底时只能粘到「工作台粘贴」，不能提示粘到视图", () => {
    const text = copySuccessNotice("config", "客户问题支持记录表")
    expect(text).toContain("工作台粘贴")
    expect(text).toContain("配置列序")
    expect(text).not.toContain("视图里")
  })

  it("缓存兜底时仍提示粘到同一个视图，并说明是按该视图列序", () => {
    const text = copySuccessNotice("cache", "客户问题支持记录表")
    expect(text).toContain("客户问题支持记录表")
    expect(text).not.toContain("工作台粘贴")
  })

  it("配置兜底提示说明原因", () => {
    expect(configFallbackNotice("X")).toContain("配置列序")
    expect(configFallbackNotice("X")).toContain("工作台粘贴")
  })
})

describe("paste-view：配置文件解析（损坏要显示，不能静默当未设置）", () => {
  it("文件不存在算没设置", () => {
    const r = parsePasteViewConfigText(null)
    expect(r.ok && r.setting === null).toBe(true)
  })

  it("JSON 坏了要报损坏", () => {
    const r = parsePasteViewConfigText("{not json")
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain("配置文件损坏")
  })

  it("缺少 viewId/viewName 也算损坏", () => {
    expect(parsePasteViewConfigText(JSON.stringify({ viewName: "X" })).ok).toBe(false)
    expect(parsePasteViewConfigText(JSON.stringify({ viewId: "v", viewName: "" })).ok).toBe(false)
  })

  it("正常配置连同缓存列序一起读出", () => {
    const r = parsePasteViewConfigText(
      JSON.stringify({ viewId: "v1", viewName: "客户问题支持记录表", columns: ["A", "B"], columnsReadAt: "2026-11-12" }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok || !r.setting) throw new Error("should parse")
    expect(r.setting.viewName).toBe("客户问题支持记录表")
    expect(r.setting.columns).toEqual(["A", "B"])
    expect(r.setting.columnsReadAt).toBe("2026-11-12")
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
