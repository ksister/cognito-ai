import type { SupportRecord } from "./types"
import { pasteWarnings, schemaPasteCells, type FeishuTableSchema } from "./feishu-schema"
import { pasteCellsForView, viewColumnNames, viewPasteWarnings, type ViewColumn } from "./paste-view"

/**
 * The user's chosen Feishu view (T16). Column order here is the order that will
 * be pasted; it must match what the user sees on screen (see paste-view.ts
 * about frozen columns).
 */
export type PasteView = { name: string; columns: ViewColumn[] }

function cell(v: string, sep: string): string {
  const s = (v ?? "").replace(/\r/g, "")
  if (s.includes(sep) || s.includes("\n") || s.includes('"')) return `"${s.replace(/"/g, '""')}"`
  return s
}

function pasteCells(
  schema: FeishuTableSchema,
  record: SupportRecord,
  view: PasteView | null | undefined,
): string[] {
  return view ? pasteCellsForView(view.columns, schema, record) : schemaPasteCells(schema, record)
}

function headerCells(schema: FeishuTableSchema, view: PasteView | null | undefined): string[] {
  return view ? viewColumnNames(view.columns) : schema.columns.map((c) => c.name)
}

/**
 * Tab-separated rows. Without a view this is the schema column order (the old
 * behaviour); with a view it is the view's visible columns, and columns the
 * workbench does not fill become empty cells (empty means "skip" in Feishu).
 */
export function toTsvRows(
  records: SupportRecord[],
  schema: FeishuTableSchema,
  withHeader = false,
  view?: PasteView | null,
): string {
  const rows = records.map((r) => pasteCells(schema, r, view).map((v) => cell(v, "\t")).join("\t"))
  if (withHeader) rows.unshift(headerCells(schema, view).map((c) => cell(c, "\t")).join("\t"))
  return rows.join("\n")
}

export function toCsv(records: SupportRecord[], schema: FeishuTableSchema): string {
  const rows = [headerCells(schema, null).map((c) => cell(c, ",")).join(",")]
  for (const r of records) rows.push(pasteCells(schema, r, null).map((v) => cell(v, ",")).join(","))
  return "\uFEFF" + rows.join("\r\n")
}

export function feishuClipboard(
  records: SupportRecord[],
  schema: FeishuTableSchema,
  view?: PasteView | null,
): { text: string; warnings: string[] } {
  return {
    text: toTsvRows(records, schema, false, view),
    warnings: [
      ...new Set(
        records.flatMap((r) => [
          ...pasteWarnings(schema, r),
          ...(view ? viewPasteWarnings(view.columns, schema, r) : []),
        ]),
      ),
    ],
  }
}
