import type { RecordDraft } from "./types"

/** Fields that carry text; an empty string from the model must not wipe the current value. */
const TEXT_FIELDS = [
  "title",
  "customer",
  "contact",
  "product",
  "status",
  "problem",
  "process",
  "solution",
  "site",
  "support_type",
  "resolution",
  "fixed_version",
  "channel",
  "module",
  "category",
  "case_visibility",
  "docs",
  "local_id",
] as const

/** Array fields; an empty array from the model must not wipe the current value. */
const ARRAY_FIELDS = ["dimensions", "inspection_types", "industries"] as const

export const REORGANIZE_FIELD_LABELS: Record<string, string> = {
  title: "标题",
  customer: "客户",
  contact: "联系人",
  product: "软件版本",
  status: "处理状态",
  problem: "问题描述",
  process: "排查过程",
  solution: "解决方案",
  site: "项目/现场",
  support_type: "支持类型",
  resolution: "解决方式",
  fixed_version: "解决版本",
  dimensions: "检测维度",
  inspection_types: "检测类型",
  industries: "行业",
  case_visibility: "是否可作案例",
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true
  if (typeof v === "string") return v.trim() === ""
  if (Array.isArray(v)) return v.length === 0
  return false
}

/**
 * Merge a re-organized draft into the current one.
 * - Empty values from the model never overwrite the current draft.
 * - `uncertain` always takes the new result.
 * - `chat` (原始聊天记录) and `thoughts` (我的思考) never change (D6).
 */
export function mergeReorganizedDraft(base: RecordDraft, next: Partial<RecordDraft>): RecordDraft {
  const out: RecordDraft = { ...base }
  for (const key of [...TEXT_FIELDS, ...ARRAY_FIELDS]) {
    const value = (next as Record<string, unknown>)[key]
    if (!isEmpty(value)) (out as Record<string, unknown>)[key] = value
  }
  if (Array.isArray(next.uncertain)) out.uncertain = next.uncertain
  out.chat = base.chat
  out.thoughts = base.thoughts
  return out
}

/** Field keys whose value changed between base and next (for the「本次修改了」hint). */
export function changedDraftFields(base: RecordDraft, next: RecordDraft): string[] {
  const keys = new Set<string>([...TEXT_FIELDS, ...ARRAY_FIELDS])
  const changed: string[] = []
  for (const key of keys) {
    const a = (base as Record<string, unknown>)[key]
    const b = (next as Record<string, unknown>)[key]
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changed.push(key)
  }
  return changed
}

export function changedFieldLabels(base: RecordDraft, next: RecordDraft): string[] {
  return changedDraftFields(base, next).map((k) => REORGANIZE_FIELD_LABELS[k] ?? k)
}
