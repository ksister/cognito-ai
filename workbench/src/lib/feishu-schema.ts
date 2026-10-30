import { NEED_TYPES, type Need, type RecordDraft } from "./types"

/**
 * Feishu table schema (D13).
 *
 * English column types:
 * - text：文本
 * - select：单选（options 必须是表里已有选项）
 * - person：人员（复制行时留空占位）
 * - attachment：附件（复制行时留空占位）
 *
 * `key` is the local frontmatter key (lowercase snake_case). Real column names
 * and options live only in KB_DIR/config/feishu-table.json, never in this file.
 */
export const FEISHU_COLUMN_TYPES = ["text", "date", "select", "multi", "person", "attachment"] as const
export type FeishuColumnType = (typeof FEISHU_COLUMN_TYPES)[number]
export type FeishuOnUnmatched = "skip" | "fallback"

export const RECORD_TEXT_KEYS = [
  "title",
  "date",
  "customer",
  "channel",
  "contact",
  "product",
  "module",
  "category",
  "status",
  "problem",
  "process",
  "solution",
  "thoughts",
  "chat",
  "site",
  "support_type",
  "resolution",
  "fixed_version",
  "case_visibility",
  "docs",
  "local_id",
] as const

export const MULTI_FIELD_KEYS = ["dimensions", "inspection_types", "industries"] as const
export type MultiFieldKey = (typeof MULTI_FIELD_KEYS)[number]

/** Closed 处理状态 from D14. Other named statuses count as open. */
export const DEFAULT_CLOSED_STATUSES = ["已解决", "搁置", "无法解决"] as const

/** Legacy local statuses mapped on read. Targets must exist in the status options. */
export const DEFAULT_STATUS_LEGACY: Record<string, string> = {
  跟进中: "AE处理中",
  已关闭: "已解决",
}

/** Statuses the D14 rules name. The private config can add the rest of the table's 11. */
export const SPEC_STATUS_OPTIONS = [
  "待处理",
  "AE处理中",
  "BUG处理中",
  "等待客户反馈",
  "转现场处理",
  "等待版本更新",
  "版本已发待验证",
  "BUG但规避处理",
  "已解决",
  "搁置",
  "无法解决",
] as const

export type RecordTextKey = (typeof RECORD_TEXT_KEYS)[number]

const KEY_RE = /^[a-z][a-z0-9_]*$/

/** Frontmatter keys that are not scalar config fields. */
const RESERVED_KEYS = new Set([
  "feishu_synced",
  "feishu_record_id",
  "feishu_synced_at",
  "needs",
  "created",
  "updated",
  "id",
  "file",
  "screenshots",
  "source",
  "followups",
  "uncertain",
  "extras",
])

const KNOWN_FRONTMATTER = new Set<string>([
  ...RECORD_TEXT_KEYS,
  ...MULTI_FIELD_KEYS,
  ...RESERVED_KEYS,
])

const TYPE_ALIASES: Record<string, FeishuColumnType> = {
  text: "text",
  文本: "text",
  select: "select",
  单选: "select",
  multi: "multi",
  多选: "multi",
  date: "date",
  日期: "date",
  person: "person",
  人员: "person",
  attachment: "attachment",
  附件: "attachment",
}

const COLUMN_PROPS = [
  "name",
  "type",
  "key",
  "extract",
  "options",
  "fieldId",
  "multiline",
  "onUnmatched",
  "fallbackOption",
  "appendOriginalTo",
  "ai",
  "closedOptions",
  "legacy",
  "consistency",
  "normalize",
  "when",
  "aliases",
  "aiSkip",
  "suggestions",
] as const

export type FeishuColumn = {
  name: string
  type: FeishuColumnType
  /** Local frontmatter key. Required for text and select. */
  key?: string
  /** When true, VL / text AI may fill this field and must obey select options. */
  extract: boolean
  options: string[]
  /** Optional Feishu field id for cli/api writes. User fills this in the private config. */
  fieldId?: string
  multiline: boolean
  onUnmatched: FeishuOnUnmatched
  fallbackOption?: string
  /** On select fallback, append the original text to this record key (D7-style). */
  appendOriginalTo?: string
  /** Shown to the model for this column. */
  ai?: string
  /** Status values that count as closed. Others with a value count as open. */
  closedOptions?: string[]
  /** Legacy status → current option, applied on read. */
  legacy?: Record<string, string>
  /** resolution value → statuses it may pair with. */
  consistency?: Record<string, string[]>
  /** "version" rewrites 445 / V4.3 into x.y.z before option matching. */
  normalize?: "version"
  /** "complex" exports process only when the chat is long or spans days. */
  when?: "complex"
  /** Chat alias → option. Private config only; the example uses fictional aliases. */
  aliases?: Record<string, string>
  /** Options the model must never choose. */
  aiSkip?: string[]
  /** Preferred site names offered before historical values. */
  suggestions?: string[]
}

export type FeishuTableSchema = {
  version: 1
  /** Join multi-select values when pasting. Change this if the test table expects another separator. */
  multiSeparator: string
  columns: FeishuColumn[]
}

export type FeishuSchemaState =
  | { ok: true; schema: FeishuTableSchema; path: string }
  | { ok: false; error: string; path: string }

export class FeishuSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FeishuSchemaError"
  }
}

export function missingSchemaMessage(filePath: string): string {
  return `未找到飞书表结构配置：${filePath}。请把 workbench/config/feishu-table.example.json 复制到该路径，按测试表「工作台粘贴」视图从左到右填写每一列的 name、type（text / select / person / attachment）和单选 options。列顺序必须与该视图一致。配置缺失时不会退回已删除的 11 列模板。真实列名和选项只放在这个私有文件里，不要提交进仓库。`
}

export function schemaFromJsonText(text: string | null, filePath: string): FeishuTableSchema {
  if (text == null) throw new FeishuSchemaError(missingSchemaMessage(filePath))
  const trimmed = text.replace(/^\uFEFF/, "").trim()
  if (!trimmed) {
    throw new FeishuSchemaError(
      `飞书表结构配置是空文件：${filePath}。请按 workbench/config/feishu-table.example.json 填写列。`,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(trimmed) as unknown
  } catch (e) {
    throw new FeishuSchemaError(
      `飞书表结构配置不是合法 JSON：${filePath}。${(e as Error).message}。请对照 workbench/config/feishu-table.example.json 修改，不要手改代码里的列。`,
    )
  }
  return parseFeishuTableSchema(raw, filePath)
}

export function parseFeishuTableSchema(raw: unknown, filePath = "feishu-table.json"): FeishuTableSchema {
  const errors: string[] = []
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FeishuSchemaError(`飞书表结构配置无效（${filePath}）：根节点必须是对象，且包含 version 与 columns。`)
  }
  const obj = raw as Record<string, unknown>
  let multiSeparator = ","
  if (obj.multiSeparator != null) {
    if (typeof obj.multiSeparator !== "string" || !obj.multiSeparator) {
      errors.push("multiSeparator 必须是非空字符串（多选粘贴分隔符，默认英文逗号）")
    } else multiSeparator = obj.multiSeparator
  }
  for (const k of Object.keys(obj)) {
    if (k !== "version" && k !== "columns" && k !== "multiSeparator") {
      errors.push(`根属性「${k}」无法识别，只能是 version、columns、multiSeparator`)
    }
  }
  if (obj.version !== 1) errors.push("version 必须是 1")
  if (!Array.isArray(obj.columns) || obj.columns.length === 0) {
    errors.push("columns 必须是非空数组，顺序即「工作台粘贴」视图从左到右的列顺序")
  }

  const columns: FeishuColumn[] = []
  const names = new Set<string>()
  const keys = new Set<string>()
  const fieldIds = new Set<string>()
  const list = Array.isArray(obj.columns) ? obj.columns : []

  list.forEach((item, index) => {
    const at = `第 ${index + 1} 列`
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${at}必须是对象`)
      return
    }
    const row = item as Record<string, unknown>
    for (const k of Object.keys(row)) {
      if (!COLUMN_PROPS.includes(k as (typeof COLUMN_PROPS)[number])) {
        errors.push(`${at}有无法识别的属性「${k}」。可用：${COLUMN_PROPS.join("、")}`)
      }
    }
    const name = typeof row.name === "string" ? row.name.trim() : ""
    if (!name) errors.push(`${at}缺少 name（表头，与粘贴视图一致）`)
    else if (names.has(name)) errors.push(`${at} name「${name}」与前面的列重复`)
    else names.add(name)

    const typeRaw = typeof row.type === "string" ? row.type.trim() : ""
    const type = TYPE_ALIASES[typeRaw]
    if (!type) {
      errors.push(`${at} type 必须是 text、date、select、multi、person、attachment（或 文本、日期、单选、多选、人员、附件）`)
    }

    let key: string | undefined
    if (row.key != null && row.key !== "") {
      if (typeof row.key !== "string" || !KEY_RE.test(row.key)) {
        errors.push(`${at} key 必须是小写英文蛇形（如 support_type），当前是 ${JSON.stringify(row.key)}`)
      } else if (RESERVED_KEYS.has(row.key) && row.key !== "needs") {
        errors.push(`${at} key「${row.key}」是记录保留字段，不能当作飞书列`)
      } else if (keys.has(row.key)) {
        errors.push(`${at} key「${row.key}」与前面的列重复`)
      } else {
        key = row.key
        keys.add(key)
      }
    } else if (type === "text" || type === "date" || type === "select" || type === "multi") {
      errors.push(`${at}（${name || "未命名"}）必须填写 key`)
    }
    if (key === "case_visibility" && row.extract === true) {
      errors.push(`${at} case_visibility（是否可作案例）不能 extract，只能用户自己选`)
    }

    let extract = false
    if (row.extract != null) {
      if (typeof row.extract !== "boolean") errors.push(`${at} extract 必须是 true 或 false`)
      else extract = row.extract
    }
    if (extract && (type === "person" || type === "attachment")) {
      errors.push(`${at}是${type === "person" ? "人员" : "附件"}列，不能 extract`)
    }

    let options: string[] = []
    if (type === "select" || type === "multi") {
      if (!Array.isArray(row.options) || row.options.length === 0) {
        errors.push(`${at}是${type === "multi" ? "多选" : "单选"}，必须提供非空 options（只能写表里已经存在的选项）`)
      } else {
        const seen = new Set<string>()
        for (const opt of row.options) {
          if (typeof opt !== "string" || !opt.trim()) {
            errors.push(`${at}的 options 每一项都必须是非空字符串`)
            continue
          }
          const label = opt.trim()
          if (seen.has(label)) errors.push(`${at}的选项「${label}」重复`)
          seen.add(label)
        }
        options = [...seen]
      }
    } else if (row.options != null) {
      errors.push(`${at}不是单选或多选，不要写 options`)
    }

    let ai: string | undefined
    if (row.ai != null && row.ai !== "") {
      if (typeof row.ai !== "string") errors.push(`${at} ai 必须是字符串`)
      else ai = row.ai.trim()
    }

    let closedOptions: string[] | undefined
    if (row.closedOptions != null) {
      if (!Array.isArray(row.closedOptions) || row.closedOptions.some((x) => typeof x !== "string" || !x.trim())) {
        errors.push(`${at} closedOptions 必须是非空字符串数组`)
      } else {
        closedOptions = row.closedOptions.map((x) => String(x).trim())
        for (const c of closedOptions) {
          if (options.length && !options.includes(c)) errors.push(`${at} closedOptions「${c}」不在 options 里`)
        }
      }
    }

    let legacy: Record<string, string> | undefined
    if (row.legacy != null) {
      if (!row.legacy || typeof row.legacy !== "object" || Array.isArray(row.legacy)) {
        errors.push(`${at} legacy 必须是 {旧值: 新选项}`)
      } else {
        legacy = {}
        for (const [from, to] of Object.entries(row.legacy as Record<string, unknown>)) {
          if (typeof to !== "string" || !to.trim()) errors.push(`${at} legacy「${from}」的目标必须是字符串`)
          else {
            legacy[from] = to.trim()
            if (options.length && !options.includes(to.trim())) {
              errors.push(`${at} legacy 目标「${to}」不在 options 里`)
            }
          }
        }
      }
    }

    let consistency: Record<string, string[]> | undefined
    if (row.consistency != null) {
      if (!row.consistency || typeof row.consistency !== "object" || Array.isArray(row.consistency)) {
        errors.push(`${at} consistency 必须是 {解决方式: [允许的处理状态]}`)
      } else {
        consistency = {}
        for (const [res, allowed] of Object.entries(row.consistency as Record<string, unknown>)) {
          if (!Array.isArray(allowed) || allowed.some((x) => typeof x !== "string" || !String(x).trim())) {
            errors.push(`${at} consistency「${res}」必须是状态数组`)
            continue
          }
          consistency[res] = allowed.map((x) => String(x).trim())
          if (options.length && !options.includes(res)) errors.push(`${at} consistency 的「${res}」不在本列 options 里`)
        }
      }
    }

    let normalize: "version" | undefined
    if (row.normalize != null) {
      if (row.normalize !== "version") errors.push(`${at} normalize 只能是 version`)
      else normalize = "version"
    }

    let when: "complex" | undefined
    if (row.when != null) {
      if (row.when !== "complex") errors.push(`${at} when 只能是 complex`)
      else when = "complex"
    }

    let aliases: Record<string, string> | undefined
    if (row.aliases != null) {
      if (!row.aliases || typeof row.aliases !== "object" || Array.isArray(row.aliases)) {
        errors.push(`${at} aliases 必须是 {别称: 选项}`)
      } else {
        aliases = {}
        for (const [from, to] of Object.entries(row.aliases as Record<string, unknown>)) {
          if (typeof to !== "string" || !to.trim()) errors.push(`${at} aliases「${from}」的目标必须是字符串`)
          else aliases[from] = to.trim()
        }
      }
    }

    let aiSkip: string[] | undefined
    if (row.aiSkip != null) {
      if (!Array.isArray(row.aiSkip) || row.aiSkip.some((x) => typeof x !== "string" || !x.trim())) {
        errors.push(`${at} aiSkip 必须是字符串数组`)
      } else aiSkip = row.aiSkip.map((x) => String(x).trim())
    }

    let suggestions: string[] | undefined
    if (row.suggestions != null) {
      if (!Array.isArray(row.suggestions) || row.suggestions.some((x) => typeof x !== "string")) {
        errors.push(`${at} suggestions 必须是字符串数组`)
      } else suggestions = row.suggestions.map((x) => String(x).trim()).filter(Boolean)
    }

    let fieldId: string | undefined
    if (row.fieldId != null && row.fieldId !== "") {
      if (typeof row.fieldId !== "string" || !row.fieldId.trim()) {
        errors.push(`${at} fieldId 必须是非空字符串`)
      } else {
        fieldId = row.fieldId.trim()
        if (fieldIds.has(fieldId)) errors.push(`${at} fieldId「${fieldId}」与前面的列重复`)
        else fieldIds.add(fieldId)
      }
    }

    let multiline = false
    if (row.multiline != null) {
      if (typeof row.multiline !== "boolean") errors.push(`${at} multiline 必须是 true 或 false`)
      else multiline = row.multiline
    }

    let onUnmatched: FeishuOnUnmatched = "skip"
    if (row.onUnmatched != null) {
      if (row.onUnmatched !== "skip" && row.onUnmatched !== "fallback") {
        errors.push(`${at} onUnmatched 只能是 skip 或 fallback`)
      } else onUnmatched = row.onUnmatched
    }
    if (onUnmatched === "fallback" && type !== "select") {
      errors.push(`${at}只有单选可以 onUnmatched: fallback`)
    }

    let fallbackOption: string | undefined
    if (row.fallbackOption != null && row.fallbackOption !== "") {
      if (typeof row.fallbackOption !== "string") errors.push(`${at} fallbackOption 必须是字符串`)
      else fallbackOption = row.fallbackOption.trim()
    }
    if (onUnmatched === "fallback") {
      if (!fallbackOption) errors.push(`${at} onUnmatched 为 fallback 时必须填写 fallbackOption，且该值要在 options 里`)
      else if (options.length && !options.includes(fallbackOption)) {
        errors.push(`${at} fallbackOption「${fallbackOption}」不在 options 里`)
      }
    }

    let appendOriginalTo: string | undefined
    if (row.appendOriginalTo != null && row.appendOriginalTo !== "") {
      if (typeof row.appendOriginalTo !== "string" || !KEY_RE.test(row.appendOriginalTo)) {
        errors.push(`${at} appendOriginalTo 必须是英文 key`)
      } else if (appendOriginalTo === key) {
        errors.push(`${at} appendOriginalTo 不能指向自己`)
      } else appendOriginalTo = row.appendOriginalTo
    }

    if (!type || !name) return
    columns.push({
      name,
      type,
      ...(key ? { key } : {}),
      extract: key === "case_visibility" || type === "person" || type === "attachment" ? false : extract,
      options,
      ...(fieldId ? { fieldId } : {}),
      multiline: multiline || key === "problem" || key === "process" || key === "solution",
      onUnmatched,
      ...(fallbackOption ? { fallbackOption } : {}),
      ...(appendOriginalTo ? { appendOriginalTo } : {}),
      ...(ai ? { ai } : {}),
      ...(closedOptions ? { closedOptions } : {}),
      ...(legacy ? { legacy } : {}),
      ...(consistency ? { consistency } : {}),
      ...(normalize ? { normalize } : {}),
      ...(when ? { when } : {}),
      ...(aliases && Object.keys(aliases).length ? { aliases } : {}),
      ...(aiSkip?.length ? { aiSkip } : {}),
      ...(suggestions?.length ? { suggestions } : {}),
    })
  })

  if (errors.length) {
    const shown = errors.slice(0, 12).join("；")
    const more = errors.length > 12 ? `；…还有 ${errors.length - 12} 个问题` : ""
    throw new FeishuSchemaError(`飞书表结构配置无效（${filePath}）：${shown}${more}`)
  }

  return { version: 1, multiSeparator, columns }
}

export function isRecordTextKey(key: string): key is RecordTextKey {
  return (RECORD_TEXT_KEYS as readonly string[]).includes(key)
}

type FieldSource = Partial<RecordDraft> & { extras?: Record<string, string> }

export function isMultiFieldKey(key: string): key is MultiFieldKey {
  return (MULTI_FIELD_KEYS as readonly string[]).includes(key)
}

export function readMulti(record: FieldSource, key: string): string[] {
  const v = (record as Record<string, unknown>)[key]
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === "string" && v.trim()) return v.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean)
  return []
}

export function readRecordField(record: FieldSource, key: string): string {
  if (key === "needs") {
    return (record.needs ?? [])
      .map((n) => (n.idea ? `${n.pain} → ${n.idea}` : n.pain))
      .filter(Boolean)
      .join("；")
  }
  if (isMultiFieldKey(key)) return readMulti(record, key).join("、")
  if (isRecordTextKey(key)) {
    const v = record[key]
    return typeof v === "string" ? v : ""
  }
  return record.extras?.[key] ?? ""
}

export function mapLegacyStatus(status: string, legacy: Record<string, string> = DEFAULT_STATUS_LEGACY): string {
  const value = status.trim()
  return legacy[value] ?? value
}

export function legacyStatusMapOf(schema: FeishuTableSchema | null | undefined): Record<string, string> {
  const col = schema?.columns.find((c) => c.key === "status")
  if (col?.legacy && Object.keys(col.legacy).length) return col.legacy
  return { ...DEFAULT_STATUS_LEGACY }
}

export function closedStatusesOf(schema: FeishuTableSchema | null | undefined): string[] {
  const col = schema?.columns.find((c) => c.key === "status")
  if (col?.closedOptions?.length) return col.closedOptions
  return [...DEFAULT_CLOSED_STATUSES]
}

export function isClosedStatus(status: string, closed: readonly string[] = DEFAULT_CLOSED_STATUSES): boolean {
  return closed.includes(status.trim())
}

/** Non-empty status that is not in the closed set. Empty is neither open nor closed. */
export function isOpenStatus(status: string, closed: readonly string[] = DEFAULT_CLOSED_STATUSES): boolean {
  const value = status.trim()
  return Boolean(value) && !closed.includes(value)
}

/** Canonical version. Two-part input stays two-part. Packed 445 → 4.4.5, 4211 → 4.2.11. Build metadata is dropped. */
export function normalizeVersion(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  const stripped = raw.replace(/-(\d+)-g[0-9a-fA-F]+.*$/, "")
  const three = stripped.match(/[vV]?(\d+)\.(\d+)\.(\d+)/)
  if (three) return `${Number(three[1])}.${Number(three[2])}.${Number(three[3])}`
  const two = stripped.match(/[vV]?(\d+)\.(\d+)/)
  if (two) return `${Number(two[1])}.${Number(two[2])}`
  if (/^\d{4}$/.test(raw)) return `${raw[0]}.${raw[1]}.${Number(raw.slice(2))}`
  if (/^\d{3}$/.test(raw)) return `${raw[0]}.${raw[1]}.${raw[2]}`
  return null
}

export type VersionMatch = { value: string; uncertain: string[] }

/** Prefer the dotted option when the table has both 445 and 4.4.5. Never auto-pick aiSkip options such as 4.12. */
export function matchVersionOption(raw: string, options: string[], aiSkip: string[] = []): VersionMatch {
  const text = raw.trim()
  if (!text) return { value: "", uncertain: [] }
  const norm = normalizeVersion(text)
  if (text === "4.12" || norm === "4.12") {
    return { value: "", uncertain: ["软件版本「4.12」可能是 4.2.12 的笔误，已留空，请确认"] }
  }
  if (!norm) return { value: "", uncertain: [] }
  const candidates = options.filter((opt) => {
    if (aiSkip.includes(opt)) return false
    return opt === norm || normalizeVersion(opt) === norm
  })
  if (!candidates.length) return { value: "", uncertain: [] }
  const dotted = candidates.find((opt) => opt === norm && opt.includes("."))
  const anyDotted = candidates.find((opt) => opt.includes("."))
  return { value: dotted ?? anyDotted ?? candidates[0], uncertain: [] }
}

/** More than 10 chat lines, or more than one calendar day, means the process column is exported. */
export function shouldExportProcess(chat: string): boolean {
  const text = chat ?? ""
  const dates = new Set<string>()
  for (const m of text.matchAll(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/g)) {
    dates.add(`${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`)
  }
  for (const m of text.matchAll(/(\d{1,2})月(\d{1,2})日/g)) {
    dates.add(`${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`)
  }
  if (dates.size > 1) return true
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[OCR") && !/^—+/.test(l) && !/^`+$/.test(l))
  return lines.length > 10
}

export function checkResolutionStatus(
  resolution: string,
  status: string,
  consistency: Record<string, string[]> | undefined,
): { resolution: string; hint: string | null; uncertain: string[] } {
  const res = resolution.trim()
  const st = status.trim()
  if (!res || !consistency || !Object.keys(consistency).length) {
    return { resolution: res, hint: null, uncertain: [] }
  }
  const allowed = consistency[res]
  if (!allowed) {
    const hint = `解决方式「${res}」没有对应的处理状态规则，已留空`
    return { resolution: "", hint, uncertain: [hint] }
  }
  if (!allowed.includes(st)) {
    const hint = `解决方式与处理状态不一致，已留空（「${res}」不能配「${st || "空"}」，只允许：${allowed.join("、")}）`
    return { resolution: "", hint, uncertain: [hint] }
  }
  return { resolution: res, hint: null, uncertain: [] }
}

function matchSelect(col: FeishuColumn, value: string): string {
  const text = value.trim()
  if (!text) return ""
  const skip = col.aiSkip ?? []
  const aliased = col.aliases?.[text] ?? text
  if (skip.includes(aliased) || skip.includes(text)) return ""
  if (col.normalize === "version") return matchVersionOption(text, col.options, skip).value
  if (col.options.includes(aliased)) return aliased
  if (col.options.includes(text)) return text
  return ""
}

export function writeRecordField<T extends FieldSource>(draft: T, key: string, value: string): T {
  if (key === "needs" || RESERVED_KEYS.has(key)) return draft
  if (isRecordTextKey(key)) return { ...draft, [key]: value }
  if (!KEY_RE.test(key)) return draft
  return { ...draft, extras: { ...(draft.extras ?? {}), [key]: value } }
}

export function sanitizeExtras(extras: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!extras) return out
  for (const [k, v] of Object.entries(extras)) {
    if (!KEY_RE.test(k) || RESERVED_KEYS.has(k) || isRecordTextKey(k)) continue
    out[k] = String(v ?? "")
  }
  return out
}

export function extrasFromFrontmatter(data: Record<string, unknown>): Record<string, string> {
  const extras: Record<string, string> = {}
  for (const [k, v] of Object.entries(data)) {
    if (KNOWN_FRONTMATTER.has(k)) continue
    if (!KEY_RE.test(k)) continue
    if (typeof v === "string" || typeof v === "number" || v instanceof Date) {
      extras[k] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
    }
  }
  return extras
}

export function schemaColumnKeys(schema: FeishuTableSchema): Set<string> {
  return new Set(schema.columns.map((c) => c.key).filter((k): k is string => Boolean(k)))
}

export function columnPasteValue(schema: FeishuTableSchema, col: FeishuColumn, record: FieldSource): string {
  if (col.type === "person" || col.type === "attachment" || !col.key) return ""
  if (col.key === "needs") return readRecordField(record, "needs")
  if (col.when === "complex") {
    if (!shouldExportProcess(record.chat ?? "")) return ""
    return (record.process ?? "").replace(/\r\n/g, "\n").trim()
  }
  if (col.type === "multi") {
    const chosen = readMulti(record, col.key).filter((v) => col.options.includes(v))
    return chosen.join(schema.multiSeparator || ",")
  }
  if (col.type === "select") return matchSelect(col, readRecordField(record, col.key))
  const text = readRecordField(record, col.key).replace(/\r\n/g, "\n").trim()
  if (col.normalize === "version") return normalizeVersion(text) ?? ""
  return text
}

/** Cell values in schema order. Person and attachment are always empty so paste does not shift. */
export function schemaPasteCells(schema: FeishuTableSchema, record: FieldSource): string[] {
  return schema.columns.map((col) => columnPasteValue(schema, col, record))
}

export function pasteWarnings(schema: FeishuTableSchema, record: FieldSource): string[] {
  const warnings: string[] = []
  for (const col of schema.columns) {
    if (!col.key) continue
    if (col.type === "select") {
      const value = readRecordField(record, col.key).trim()
      if (value && !matchSelect(col, value)) {
        warnings.push(`「${col.name}」的「${value}」不是已有选项，复制时该列留空`)
      }
    }
    if (col.type === "multi") {
      const dropped = readMulti(record, col.key).filter((v) => !col.options.includes(v))
      if (dropped.length) {
        warnings.push(`「${col.name}」里的「${dropped.join("、")}」不是已有选项，复制时已去掉`)
      }
    }
  }
  return warnings
}

export function schemaHasWritableFieldId(schema: FeishuTableSchema): boolean {
  return schema.columns.some((c) => Boolean(c.fieldId) && c.type !== "attachment")
}

/**
 * Map a draft onto Feishu create fields using the schema only.
 * Does not guess that 渠道→支持类型 or 模块→项目/现场.
 * Columns without fieldId are skipped (clipboard paste does not need field ids).
 */
export function buildCreateFields(
  draft: RecordDraft,
  schema: FeishuTableSchema,
  companyOption: string | undefined,
  handlerOpenIds: string[] | undefined,
  warnings: string[],
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  const appends: { key: string; text: string }[] = []

  for (const col of schema.columns) {
    if (col.type === "attachment" || !col.fieldId) continue

    if (col.type === "person") {
      const ids = (handlerOpenIds ?? []).map((id) => id.trim()).filter((id) => id.startsWith("ou_"))
      if (ids.length) fields[col.fieldId] = ids.map((id) => ({ id }))
      continue
    }

    if (!col.key) continue
    if (col.type === "multi") {
      const chosen = readMulti(draft, col.key).filter((v) => col.options.includes(v))
      const dropped = readMulti(draft, col.key).filter((v) => !col.options.includes(v))
      if (chosen.length) fields[col.fieldId] = chosen
      if (dropped.length) warnings.push(`「${col.name}」的「${dropped.join("、")}」不是已有选项，已跳过`)
      continue
    }

    let value = readRecordField(draft, col.key).replace(/\r\n/g, "\n").trim()
    if (col.type === "select" && col.key === "customer" && companyOption && col.options.includes(companyOption)) {
      value = companyOption
    }

    if (col.type === "select") {
      const hit = value && col.options.includes(value) ? value : matchSelect(col, value)
      if (hit) {
        fields[col.fieldId] = hit
        continue
      }
      if (!value) continue
      if (col.onUnmatched === "fallback" && col.fallbackOption && col.options.includes(col.fallbackOption)) {
        fields[col.fieldId] = col.fallbackOption
        warnings.push(`「${col.name}」未命中选项，已写入「${col.fallbackOption}」`)
        if (col.appendOriginalTo) appends.push({ key: col.appendOriginalTo, text: value })
        continue
      }
      warnings.push(`「${col.name}」的「${value}」不是已有选项，已跳过`)
      continue
    }

    const pasted = columnPasteValue(schema, col, draft)
    if (pasted) fields[col.fieldId] = pasted
  }

  for (const append of appends) {
    const target = schema.columns.find((c) => c.key === append.key && c.fieldId && c.type === "text")
    if (!target?.fieldId) {
      warnings.push(`未命中的原文未能并入「${append.key}」（该列没有文本 fieldId）`)
      continue
    }
    const prev = typeof fields[target.fieldId] === "string" ? String(fields[target.fieldId]) : ""
    const merged = [append.text, prev].filter(Boolean).join(" / ")
    if (merged) fields[target.fieldId] = merged
  }

  return fields
}

const LOCAL_NARRATIVE: { key: RecordTextKey; desc: string }[] = [
  { key: "title", desc: "一句话标题，20字内。没有就 null" },
  { key: "date", desc: "YYYY-MM-DD，聊天中最早的日期，找不到就 null" },
  { key: "contact", desc: "客户方联系人，未知 null" },
  { key: "problem", desc: "客户遇到的问题，含现象和关键参数" },
  { key: "process", desc: "排查与沟通过程，用 1. 2. 3. 分步" },
  { key: "solution", desc: "最终解决方案或当前结论，未解决就写明卡在哪里" },
]

function columnByKey(schema: FeishuTableSchema, key: string): FeishuColumn | undefined {
  return schema.columns.find((c) => c.key === key)
}

function selectRule(col: FeishuColumn): string {
  return `只能是以下选项之一，必须原样复制，不允许自造；都不符合或不确定就 null：${col.options.join("|")}`
}

function fieldLine(col: FeishuColumn, fallback: string): string {
  const rule = col.ai ? `${col.ai}。${fallback}` : fallback
  if (!col.key) return ""
  if (col.type === "select") return `  "${col.key}": "${selectRule(col)}。${rule}"`
  if (col.type === "multi") {
    return `  "${col.key}": "多选，只能从 ${col.options.join("|")} 里选，返回字符串数组；判断不了就 []。${rule}"`
  }
  if (col.normalize === "version") return `  "${col.key}": "版本号，统一成 x.y.z（例如 445 写成 4.4.5）。${rule}"`
  return `  "${col.key}": "${rule}"`
}

/** System prompt: select fields carry their allowed options. */
export function buildExtractSystem(schema: FeishuTableSchema, source: "screenshot" | "paste"): string {
  const lead =
    source === "screenshot"
      ? "你是一名机器视觉公司的 AE（应用工程师）助理。用户会按时间顺序上传多张微信或飞书的技术支持聊天截图，你要合并为同一会话，整理成结构化的技术支持记录。"
      : "你是一名机器视觉公司的 AE（应用工程师）助理。用户会给你一段与客户的技术支持聊天记录（来自微信或飞书），你要把它整理成结构化的技术支持记录。"

  const lines: string[] = []
  const emitted = new Set<string>()

  for (const item of LOCAL_NARRATIVE) {
    const col = columnByKey(schema, item.key)
    if (col && !col.extract) continue
    emitted.add(item.key)
    lines.push(col ? fieldLine(col, item.desc) : `  "${item.key}": "${item.desc}"`)
  }

  for (const col of schema.columns) {
    if (!col.extract || !col.key || emitted.has(col.key) || col.key === "needs" || col.key === "case_visibility") continue
    if (col.type === "person" || col.type === "attachment") continue
    emitted.add(col.key)
    lines.push(fieldLine(col, "未知 null"))
  }

  lines.push(
    `  "needs": [{"pain": "用户痛点", "idea": "改进或工具想法", "type": "${NEED_TYPES.join("|")}"}]`,
  )
  lines.push(`  "uncertain": ["需要人工确认的点"]`)

  return `${lead}

严格要求：
1. 只根据${source === "screenshot" ? "截图中可见的文字与界面信息" : "聊天原文"}整理，不要编造原文没有的事实。看不清或不确定的字段填 null，并写入 uncertain。
2. ${source === "screenshot" ? "多张截图按上传顺序拼接为同一段对话，不要当成多条独立记录。" : "凡是你不确定的地方（客户名、型号、版本、问题是否真正解决、因果关系、指代不清），都写进 uncertain，每条写清楚「哪里不确定 + 原文依据」。"}
3. 单选只能从给出的选项里原样选一个，多选只能从给出的选项里选。没有把握或没有选项符合时，单选填 null、多选填 []，并在 uncertain 写明「哪一列对不上」。禁止发明选项。不要输出 case_visibility（是否可作案例）。
4. needs 用来沉淀产品需求线索：从抱怨、绕路做法、「能不能/希望/太麻烦」等表达中提炼。没有就返回空数组。解决方式必须与处理状态一致，对不上就让解决方式为 null。
5. 使用简体中文，简洁具体，保留关键参数。只输出 JSON，不要 Markdown 围栏或其他说明。

输出 JSON：
{
${lines.join(",\n")}
}`
}

function scalar(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") {
    const t = v.trim()
    if (t === "null" || t === "NULL") return ""
    return t
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}

function parseNeeds(v: unknown): Need[] {
  if (!Array.isArray(v)) return []
  return v
    .map((n) => {
      const row = n as { pain?: unknown; idea?: unknown; type?: unknown }
      const type = NEED_TYPES.includes(row.type as never) ? (row.type as Need["type"]) : "其他"
      return { pain: scalar(row.pain), idea: scalar(row.idea), type }
    })
    .filter((n) => n.pain || n.idea)
}

function assignExtracted(out: Partial<RecordDraft>, extras: Record<string, string>, key: string, value: string) {
  if (key === "thoughts" || key === "chat" || key === "needs") return
  if (isRecordTextKey(key)) {
    out[key] = value
    return
  }
  extras[key] = value
}

/** Keep select values only when they are configured options; otherwise blank + uncertain. */
export function normalizeExtractedDraft(
  raw: Record<string, unknown>,
  schema: FeishuTableSchema,
): Partial<RecordDraft> {
  const uncertain = Array.isArray(raw.uncertain) ? raw.uncertain.map((u) => String(u)) : []
  const extras: Record<string, string> = {}
  const out: Partial<RecordDraft> = {}
  const handled = new Set<string>()

  for (const col of schema.columns) {
    if (!col.key || col.type === "person" || col.type === "attachment" || !col.extract) continue
    if (col.key === "case_visibility" || col.key === "needs") continue
    handled.add(col.key)
    let text = scalar(raw[col.key])
    if (col.key === "status") text = mapLegacyStatus(text, col.legacy ?? DEFAULT_STATUS_LEGACY)
    if (col.type === "multi") {
      const rawList = Array.isArray(raw[col.key])
        ? (raw[col.key] as unknown[]).map((v) => scalar(v))
        : text.split(/[,，、;；]/).map((v) => v.trim()).filter(Boolean)
      const kept = rawList.filter((v) => col.options.includes(v))
      const dropped = rawList.filter((v) => v && !col.options.includes(v))
      if (isMultiFieldKey(col.key)) (out as Record<string, unknown>)[col.key] = kept
      if (dropped.length) uncertain.push(`「${col.name}」无法匹配已有选项，已去掉（模型给出「${dropped.join("、")}」）`)
      continue
    }
    if (col.type === "select") {
      if (col.normalize === "version") {
        const matched = matchVersionOption(text, col.options, col.aiSkip ?? [])
        assignExtracted(out, extras, col.key, matched.value)
        for (const line of matched.uncertain) uncertain.push(line)
        if (text && !matched.value && !matched.uncertain.length) {
          uncertain.push(`「${col.name}」无法匹配已有选项，已留空（模型给出「${text}」）`)
        }
        continue
      }
      const hit = matchSelect(col, text)
      if (hit) assignExtracted(out, extras, col.key, hit)
      else if (text) {
        assignExtracted(out, extras, col.key, "")
        const skipped = (col.aiSkip ?? []).includes(text) || (col.aliases?.[text] && (col.aiSkip ?? []).includes(col.aliases[text]))
        uncertain.push(
          skipped
            ? `「${col.name}」的「${text}」不能由 AI 自动选择，已留空`
            : `「${col.name}」无法匹配已有选项，已留空（模型给出「${text}」）`,
        )
      } else assignExtracted(out, extras, col.key, "")
      continue
    }
    assignExtracted(out, extras, col.key, text)
  }

  for (const item of LOCAL_NARRATIVE) {
    if (handled.has(item.key)) continue
    const col = columnByKey(schema, item.key)
    if (col && !col.extract) continue
    if (!(item.key in raw)) continue
    handled.add(item.key)
    assignExtracted(out, extras, item.key, scalar(raw[item.key]))
  }

  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) {
    uncertain.push(`日期「${out.date}」不是 YYYY-MM-DD，已留空`)
    delete out.date
  }

  const resolutionCol = columnByKey(schema, "resolution")
  const checked = checkResolutionStatus(out.resolution ?? "", out.status ?? "", resolutionCol?.consistency)
  if (checked.hint) {
    out.resolution = ""
    for (const line of checked.uncertain) {
      if (!uncertain.includes(line)) uncertain.push(line)
    }
  }

  out.needs = parseNeeds(raw.needs)
  out.uncertain = uncertain
  if (Object.keys(extras).length) out.extras = extras
  return out
}

export function constrainDraftSelects<T extends Partial<RecordDraft>>(draft: T, schema: FeishuTableSchema): T {
  const uncertain = [...(draft.uncertain ?? [])]
  let next: T = { ...draft, uncertain }
  for (const col of schema.columns) {
    if (col.type !== "select" || !col.key) continue
    const current = readRecordField(next, col.key).trim()
    if (!current || matchSelect(col, current)) {
      if (current && matchSelect(col, current) !== current) {
        next = { ...writeRecordField(next, col.key, matchSelect(col, current)), uncertain }
      }
      continue
    }
    uncertain.push(`「${col.name}」无法匹配已有选项，已留空（给出的是「${current}」）`)
    next = { ...writeRecordField(next, col.key, ""), uncertain }
  }
  const resolutionCol = schema.columns.find((c) => c.key === "resolution")
  const checked = checkResolutionStatus(
    readRecordField(next, "resolution"),
    readRecordField(next, "status"),
    resolutionCol?.consistency,
  )
  if (checked.hint) {
    next = { ...writeRecordField(next, "resolution", ""), uncertain: [...uncertain, ...checked.uncertain] }
  }
  return next
}

/** Merge an extraction into the form draft. Select clears (empty string) are kept; other blanks are not. */
export function mergeExtractedDraft(
  prev: RecordDraft,
  extracted: Partial<RecordDraft>,
  schema: FeishuTableSchema | null,
): RecordDraft {
  const selectKeys = new Set(
    (schema?.columns ?? []).filter((c) => c.type === "select" && c.key).map((c) => c.key as string),
  )
  let next: RecordDraft = { ...prev, extras: { ...(prev.extras ?? {}) }, customer: prev.customer, chat: prev.chat, thoughts: prev.thoughts }
  for (const [k, v] of Object.entries(extracted)) {
    if (k === "chat" || k === "thoughts" || k === "case_visibility") continue
    if (k === "customer") {
      if (!prev.customer.trim() && typeof v === "string" && v) next = writeRecordField(next, "customer", v)
      continue
    }
    if (isMultiFieldKey(k) && Array.isArray(v)) {
      next = { ...next, [k]: v.map((item) => String(item)).filter(Boolean) }
      continue
    }
    if (k === "extras" && v && typeof v === "object" && !Array.isArray(v)) {
      const extras = { ...next.extras }
      for (const [ek, ev] of Object.entries(v as Record<string, string>)) extras[ek] = ev ?? ""
      next = { ...next, extras }
      continue
    }
    if (k === "needs" || k === "uncertain") {
      if (v == null) continue
      next = { ...next, [k]: v } as RecordDraft
      continue
    }
    if (typeof v !== "string") continue
    if (!v && !selectKeys.has(k)) continue
    next = writeRecordField(next, k, v)
  }
  return next
}

export function attachmentFieldId(schema: FeishuTableSchema): string | undefined {
  return schema.columns.find((c) => c.type === "attachment")?.fieldId
}

export type OptionDiff = {
  name: string
  key?: string
  before: string[]
  after: string[]
  added: string[]
  removed: string[]
}

export type OptionSyncPreview = {
  changes: OptionDiff[]
  unchanged: string[]
  missingInFeishu: string[]
  missingInConfig: string[]
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** Compare select/multi options by column name. Does not touch keys, AI rules, or field ids. */
export function diffColumnOptions(
  schema: FeishuTableSchema,
  fields: { name: string; options: string[] }[],
): OptionSyncPreview {
  const byName = new Map(fields.filter((f) => f.options.length).map((f) => [f.name, f.options]))
  const changes: OptionDiff[] = []
  const unchanged: string[] = []
  const missingInFeishu: string[] = []
  const used = new Set<string>()
  for (const col of schema.columns) {
    if (col.type !== "select" && col.type !== "multi") continue
    const after = byName.get(col.name)
    if (!after) {
      missingInFeishu.push(col.name)
      continue
    }
    used.add(col.name)
    if (sameList(col.options, after)) unchanged.push(col.name)
    else {
      const beforeSet = new Set(col.options)
      const afterSet = new Set(after)
      changes.push({
        name: col.name,
        key: col.key,
        before: col.options,
        after,
        added: after.filter((v) => !beforeSet.has(v)),
        removed: col.options.filter((v) => !afterSet.has(v)),
      })
    }
  }
  const configNames = new Set(
    schema.columns.filter((c) => c.type === "select" || c.type === "multi").map((c) => c.name),
  )
  const missingInConfig = [...byName.keys()].filter((name) => !configNames.has(name) && !used.has(name))
  return { changes, unchanged, missingInFeishu, missingInConfig }
}

/** Replace options on columns named in the diff. Leaves every other property untouched. */
export function applyOptionDiff(raw: unknown, changes: OptionDiff[]): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw
  const root = raw as { columns?: unknown }
  if (!Array.isArray(root.columns)) return raw
  const byName = new Map(changes.map((c) => [c.name, c.after]))
  return {
    ...root,
    columns: root.columns.map((col) => {
      if (!col || typeof col !== "object" || Array.isArray(col)) return col
      const name = (col as { name?: unknown }).name
      if (typeof name !== "string" || !byName.has(name)) return col
      return { ...(col as Record<string, unknown>), options: byName.get(name) }
    }),
  }
}
