import type { SupportRecord } from "./types"

// 列顺序需与飞书"技术支持表格"一致，粘贴时才能对齐；按实际表头调整即可。
export const FEISHU_COLUMNS: { header: string; value: (r: SupportRecord) => string }[] = [
  { header: "日期", value: (r) => r.date },
  { header: "客户", value: (r) => r.customer },
  { header: "联系人", value: (r) => r.contact },
  { header: "渠道", value: (r) => r.channel },
  { header: "产品/版本", value: (r) => r.product },
  { header: "模块", value: (r) => r.module },
  { header: "问题分类", value: (r) => r.category },
  { header: "问题描述", value: (r) => r.problem },
  { header: "解决方案", value: (r) => r.solution },
  { header: "状态", value: (r) => r.status },
  { header: "需求线索", value: (r) => r.needs.map((n) => n.pain + (n.idea ? ` → ${n.idea}` : "")).join("\n") },
]

function cell(v: string, sep: string): string {
  const s = (v ?? "").replace(/\r/g, "")
  if (s.includes(sep) || s.includes("\n") || s.includes('"')) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function toTsvRows(records: SupportRecord[], withHeader = false): string {
  const rows = records.map((r) => FEISHU_COLUMNS.map((c) => cell(c.value(r), "\t")).join("\t"))
  if (withHeader) rows.unshift(FEISHU_COLUMNS.map((c) => c.header).join("\t"))
  return rows.join("\n")
}

export function toCsv(records: SupportRecord[]): string {
  const rows = [FEISHU_COLUMNS.map((c) => c.header).join(",")]
  for (const r of records) rows.push(FEISHU_COLUMNS.map((c) => cell(c.value(r), ",")).join(","))
  return "\uFEFF" + rows.join("\r\n")
}
