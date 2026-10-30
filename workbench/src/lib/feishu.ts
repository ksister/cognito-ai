import type { SupportRecord } from "./types"
import { pasteWarnings, schemaPasteCells, type FeishuTableSchema } from "./feishu-schema"

function cell(v: string, sep: string): string {
  const s = (v ?? "").replace(/\r/g, "")
  if (s.includes(sep) || s.includes("\n") || s.includes('"')) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** Tab-separated row in schema column order. Requires a loaded schema — there is no built-in column list. */
export function toTsvRows(records: SupportRecord[], schema: FeishuTableSchema, withHeader = false): string {
  const rows = records.map((r) => schemaPasteCells(schema, r).map((v) => cell(v, "\t")).join("\t"))
  if (withHeader) rows.unshift(schema.columns.map((c) => cell(c.name, "\t")).join("\t"))
  return rows.join("\n")
}

export function toCsv(records: SupportRecord[], schema: FeishuTableSchema): string {
  const rows = [schema.columns.map((c) => cell(c.name, ",")).join(",")]
  for (const r of records) rows.push(schemaPasteCells(schema, r).map((v) => cell(v, ",")).join(","))
  return "\uFEFF" + rows.join("\r\n")
}

export function feishuClipboard(
  records: SupportRecord[],
  schema: FeishuTableSchema,
): { text: string; warnings: string[] } {
  return {
    text: toTsvRows(records, schema),
    warnings: [...new Set(records.flatMap((r) => pasteWarnings(schema, r)))],
  }
}
