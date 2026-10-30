import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { toTsvRows } from "./feishu"
import {
  applyOptionDiff,
  buildCreateFields,
  buildExtractSystem,
  checkResolutionStatus,
  diffColumnOptions,
  FeishuSchemaError,
  matchVersionOption,
  normalizeExtractedDraft,
  normalizeVersion,
  parseFeishuTableSchema,
  schemaFromJsonText,
  schemaPasteCells,
  shouldExportProcess,
} from "./feishu-schema"
import { emptyDraft, type RecordDraft, type SupportRecord } from "./types"

const examplePath = path.join(process.cwd(), "config", "feishu-table.example.json")
const example = parseFeishuTableSchema(JSON.parse(readFileSync(examplePath, "utf8")), examplePath)

const COLUMN_KEYS = [
  "title",
  "date",
  "customer",
  "contact",
  "site",
  "support_type",
  "status",
  "resolution",
  "product",
  "fixed_version",
  "problem",
  "solution",
  "process",
  "dimensions",
  "inspection_types",
  "industries",
  "case_visibility",
  "docs",
  "local_id",
  "needs",
]

function draft(patch: Partial<RecordDraft> = {}): SupportRecord {
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

describe("feishu table schema", () => {
  it("parses the 20-column fictional example in paste order", () => {
    expect(example.columns).toHaveLength(20)
    expect(example.columns.map((c) => c.key)).toEqual(COLUMN_KEYS)
    expect(example.multiSeparator).toBe(",")
    expect(example.columns.find((c) => c.key === "case_visibility")?.extract).toBe(false)
    expect(JSON.stringify(example)).not.toMatch(/fld[A-Za-z0-9]{8,}/)
    expect(JSON.stringify(example)).not.toMatch(/宁德|深圳某/)
  })

  it("rejects a missing file instead of inventing columns", () => {
    expect(() => schemaFromJsonText(null, "/tmp/kb/config/feishu-table.json")).toThrow(FeishuSchemaError)
    expect(() => schemaFromJsonText(null, "/tmp/kb/config/feishu-table.json")).toThrow(/未找到飞书表结构配置/)
    expect(() => schemaFromJsonText(null, "/tmp/kb/config/feishu-table.json")).toThrow(/不会退回/)
  })

  it("normalizes version strings to x.y.z", () => {
    expect(normalizeVersion("445")).toBe("4.4.5")
    expect(normalizeVersion("4.4.5")).toBe("4.4.5")
    expect(normalizeVersion("V4.3")).toBe("4.3")
    expect(normalizeVersion("v4.4.5")).toBe("4.4.5")
    expect(normalizeVersion("视觉软件 V4.3")).toBe("4.3")
    expect(normalizeVersion("4.3")).toBe("4.3")
    expect(normalizeVersion("4211")).toBe("4.2.11")
    expect(normalizeVersion("v4.2.10-3-g006ab0da7")).toBe("4.2.10")
    expect(normalizeVersion("4.10.2")).toBe("4.10.2")
    expect(normalizeVersion("4.4.05")).toBe("4.4.5")
    expect(normalizeVersion("")).toBeNull()
    expect(normalizeVersion("没有版本")).toBeNull()
  })

  it("prefers the dotted version and never auto-picks 4.12", () => {
    const options = ["445", "4.4.5", "4.12", "4.2.12"]
    expect(matchVersionOption("445", options).value).toBe("4.4.5")
    expect(matchVersionOption("4.12", options, ["4.12"]).value).toBe("")
    expect(matchVersionOption("4.12", options, ["4.12"]).uncertain[0]).toMatch(/4\.2\.12/)
    const draftOut = normalizeExtractedDraft({ product: "4.12", uncertain: [] }, example)
    expect(draftOut.product).toBe("")
    expect(draftOut.uncertain?.join("\n")).toMatch(/4\.2\.12/)
  })

  it("matches a packed version to a configured option when pasting", () => {
    const record = draft({ product: "445", customer: "示例-星河电子" })
    const cells = schemaPasteCells(example, record)
    expect(cells[8]).toBe("4.4.5")
    expect(cells).toHaveLength(20)
  })

  it("leaves resolution empty when it disagrees with status", () => {
    const checked = checkResolutionStatus("已修复", "AE处理中", example.columns.find((c) => c.key === "resolution")?.consistency)
    expect(checked.resolution).toBe("")
    expect(checked.hint).toMatch(/不一致/)
    expect(checked.uncertain[0]).toMatch(/已留空/)

    const ok = checkResolutionStatus("已修复", "已解决", example.columns.find((c) => c.key === "resolution")?.consistency)
    expect(ok.resolution).toBe("已修复")
    expect(ok.hint).toBeNull()

    const draftOut = normalizeExtractedDraft(
      { title: "读码偏了", status: "AE处理中", resolution: "已修复", support_type: "bug确认", uncertain: [] },
      example,
    )
    expect(draftOut.resolution).toBe("")
    expect(draftOut.status).toBe("AE处理中")
    expect(draftOut.support_type).toBe("bug确认")
    expect(draftOut.uncertain?.join("\n")).toMatch(/不一致/)
  })

  it("does not ask the model to fill case visibility", () => {
    const prompt = buildExtractSystem(example, "screenshot")
    expect(prompt).not.toMatch(/"case_visibility":/)
    expect(prompt).toContain("bug确认")
    expect(prompt).toContain("2D")
    const draftOut = normalizeExtractedDraft(
      { case_visibility: "示例-可对内分享", support_type: "现场支持", dimensions: ["2D", "编造"], uncertain: [] },
      example,
    )
    expect(draftOut.case_visibility).toBeUndefined()
    expect(draftOut.support_type).toBe("")
    expect(draftOut.dimensions).toEqual(["2D"])
    expect(draftOut.uncertain?.join("\n")).toMatch(/无法匹配已有选项/)
  })

  it("exports process only when the chat is long or spans days", () => {
    expect(shouldExportProcess("一行")).toBe(false)
    expect(shouldExportProcess(Array.from({ length: 11 }, (_, i) => `第${i}条`).join("\n"))).toBe(true)
    expect(shouldExportProcess("10月28日 早\n10月29日 晚")).toBe(true)
    const quiet = draft({ process: "排查了很久", chat: "只有几句" })
    const loud = draft({ process: "排查了很久", chat: "10月1日\n10月2日" })
    expect(schemaPasteCells(example, quiet)[12]).toBe("")
    expect(schemaPasteCells(example, loud)[12]).toBe("排查了很久")
  })

  it("joins multi-select with the configurable separator and formats needs", () => {
    const record = draft({
      dimensions: ["2D", "3D"],
      needs: [{ pain: "每次换料要远程", idea: "一键重学模板", type: "软件改进" }],
      local_id: "AE-20261015-01",
    })
    const cells = schemaPasteCells(example, record)
    expect(cells[13]).toBe("2D,3D")
    expect(cells[18]).toBe("AE-20261015-01")
    expect(cells[19]).toBe("每次换料要远程 → 一键重学模板")
    const custom = parseFeishuTableSchema({ ...JSON.parse(readFileSync(examplePath, "utf8")), multiSeparator: "、" })
    expect(schemaPasteCells(custom, record)[13]).toBe("2D、3D")
    expect(toTsvRows([record], example).split("\t")).toHaveLength(20)
  })

  it("does not map channel onto support_type", () => {
    const schema = parseFeishuTableSchema({
      version: 1,
      columns: [
        { name: "支持类型", type: "select", key: "support_type", fieldId: "fld_example_support", options: ["bug确认"], extract: true },
        { name: "渠道", type: "text", key: "channel", fieldId: "fld_example_channel" },
        { name: "处理人", type: "person", fieldId: "fld_example_person" },
        { name: "截图", type: "attachment", fieldId: "fld_example_file" },
      ],
    })
    const warnings: string[] = []
    const fields = buildCreateFields(
      draft({ channel: "微信", support_type: "bug确认" }),
      schema,
      undefined,
      ["ou_example"],
      warnings,
    )
    expect(fields.fld_example_support).toBe("bug确认")
    expect(fields.fld_example_channel).toBe("微信")
    expect(fields.fld_example_person).toEqual([{ id: "ou_example" }])
    expect(fields.fld_example_file).toBeUndefined()
    const dated = buildCreateFields(
      draft({
        date: "2026-10-15",
        dimensions: ["2D", "3D"],
        customer: "示例-星河电子",
      }),
      parseFeishuTableSchema({
        version: 1,
        people: { fieldName: "处理人", fieldId: "fld_example_person", defaultOpenId: "ou_self" },
        columns: [
          { name: "创建时间", type: "date", key: "date", fieldId: "fld_example_date" },
          { name: "检测维度", type: "multi", key: "dimensions", fieldId: "fld_example_dims", options: ["2D", "3D"] },
        ],
      }),
      undefined,
      undefined,
      [],
    )
    expect(dated.fld_example_date).toBe(Date.parse("2026-10-15T00:00:00"))
    expect(dated.fld_example_dims).toEqual(["2D", "3D"])
    expect(dated.fld_example_person).toEqual([{ id: "ou_self" }])
    expect(schemaPasteCells(schema, draft({ channel: "微信" }))[2]).toBe("")
  })

  it("diffs option lists without rewriting other column fields", () => {
    const preview = diffColumnOptions(example, [
      { name: "支持类型", options: ["使用问题反馈", "bug确认", "需求", "设备/驱动问题", "demo", "示例-新增"] },
      { name: "不在配置里的列", options: ["甲"] },
    ])
    expect(preview.changes.find((c) => c.name === "支持类型")?.added).toEqual(["示例-新增"])
    expect(preview.missingInConfig).toContain("不在配置里的列")
    const next = applyOptionDiff(
      { version: 1, columns: [{ name: "支持类型", key: "support_type", type: "select", options: ["bug确认"], ai: "保留" }] },
      preview.changes.filter((c) => c.name === "支持类型"),
    ) as { columns: { ai?: string; options: string[] }[] }
    expect(next.columns[0].ai).toBe("保留")
    expect(next.columns[0].options).toContain("示例-新增")
  })
})
