import {
  columnPasteValue,
  type FeishuColumn,
  type FeishuTableSchema,
  type FieldSource,
} from "./feishu-schema"

/**
 * T16：「复制为飞书行」按用户选定的飞书视图生成。
 *
 * 实测结论（2026-11-11，测试表，用户手动粘贴 + 只读回读核对）：
 * - 飞书粘贴按当前视图「屏幕上从左到右」的可见列定位，隐藏列直接跳过；
 * - 空单元格是「跳过」：不占位、不报错、不挤压后面的值，所以工作台不填的列输出空字符串；
 * - 单元格数超过视图可见列数时，飞书会新建字段，所以列数必须正好等于视图可见列数；
 * - 单选列粘到不存在的值时，飞书不报错而是静默新建选项，所以列序必须精确。
 *
 * 顺带发现：视图「冻结列」会显示在最左，优先级高于视图列序；而 lark-cli 的
 * `+view-get-visible-fields` 不含冻结信息。冻结列不在最左时，按接口列序生成的 TSV 会错位。
 * 这一条无法自动检测，所以设置页把将要输出的列序列出来，并提示用户核对。
 */

/** 视图里的一列，只保留名字（类型只用于设置页展示）。 */
export type ViewColumn = { name: string; type?: string }

/** 调用方可以传列名数组，也可以传 {name} 对象数组。 */
export type ViewColumnsInput = ReadonlyArray<string | ViewColumn>

/** KB_DIR/config/paste-view.json：id 用来读，名字只用于界面显示。 */
export type PasteViewSetting = {
  viewId: string
  viewName: string
  updatedAt?: string
  /** 上次成功读到的列名，现场读不到时兜底用。 */
  columns?: string[]
  /** 缓存列序的读取日期（YYYY-MM-DD，本地时区）。 */
  columnsReadAt?: string
}

/** 一个视图列对应的落位：column 为空说明工作台不填这一列，value 是空占位。 */
export type PasteSlot = {
  viewName: string
  column?: FeishuColumn
  value: string
}

export function viewColumnNames(columns: ViewColumnsInput): string[] {
  return columns.map((c) => (typeof c === "string" ? c : c.name)).map((n) => n.trim())
}

/** 视图列名 → 配置里的列。`feishuName` 允许配置名和飞书列名不同。 */
export function findSchemaColumn(schema: FeishuTableSchema, viewName: string): FeishuColumn | undefined {
  const wanted = viewName.trim()
  if (!wanted) return undefined
  return schema.columns.find((c) => c.name === wanted || c.feishuName === wanted)
}

/** 工作台永远不填的列：人员、附件、没有对应本地字段的列。 */
export function isPlaceholderColumn(column: FeishuColumn | undefined): boolean {
  if (!column) return true
  return column.type === "person" || column.type === "attachment" || !column.key
}

export function buildPasteSlots(
  viewColumns: ViewColumnsInput,
  schema: FeishuTableSchema,
  record: FieldSource,
): PasteSlot[] {
  return viewColumnNames(viewColumns).map((viewName) => {
    const column = findSchemaColumn(schema, viewName)
    return {
      viewName,
      column,
      value: column ? columnPasteValue(schema, column, record) : "",
    }
  })
}

/** 按视图可见列顺序输出单元格。列数正好等于视图可见列数（多一个就会让飞书新建字段）。 */
export function pasteCellsForView(
  viewColumns: ViewColumnsInput,
  schema: FeishuTableSchema,
  record: FieldSource,
): string[] {
  return buildPasteSlots(viewColumns, schema, record).map((slot) => slot.value)
}

/**
 * 工作台会填、但这个视图隐藏了的列：粘贴会静默丢掉内容，必须提示。
 * 人员/附件不在提示范围（本来就是空占位）。
 */
export function columnsDroppedByView(
  viewColumns: ViewColumnsInput,
  schema: FeishuTableSchema,
  record: FieldSource,
): string[] {
  const visible = new Set(viewColumnNames(viewColumns))
  return schema.columns
    .filter((col) => !isPlaceholderColumn(col))
    .filter((col) => !visible.has(col.name) && !(col.feishuName && visible.has(col.feishuName)))
    .filter((col) => columnPasteValue(schema, col, record).trim() !== "")
    .map((col) => col.name)
}

/** 视图里工作台不填的列（设置页用来解释空占位）。 */
export function placeholderViewColumns(
  viewColumns: ViewColumnsInput,
  schema: FeishuTableSchema,
): string[] {
  return viewColumnNames(viewColumns).filter((name) => isPlaceholderColumn(findSchemaColumn(schema, name)))
}

/**
 * 配置里有、但视图隐藏了的列（与记录无关的静态判断）。
 * 设置页用它提前告诉用户：换成这个视图会丢掉哪些内容。
 */
export function hiddenSchemaColumns(
  viewColumns: ViewColumnsInput,
  schema: FeishuTableSchema,
): string[] {
  const visible = new Set(viewColumnNames(viewColumns))
  return schema.columns
    .filter((col) => !isPlaceholderColumn(col))
    .filter((col) => !visible.has(col.name) && !(col.feishuName && visible.has(col.feishuName)))
    .map((col) => col.name)
}

/** 复制时附带的提示。只提示会丢内容的隐藏列，不提示「工作台不填」的空占位。 */
export function viewPasteWarnings(
  viewColumns: ViewColumnsInput,
  schema: FeishuTableSchema,
  record: FieldSource,
): string[] {
  const dropped = columnsDroppedByView(viewColumns, schema, record)
  if (!dropped.length) return []
  return [`这个视图隐藏了 ${dropped.length} 列，这些内容不会带上：${dropped.join("、")}`]
}

/**
 * 复制时列序的来源（T16）：
 * - live：刚刚从飞书读到
 * - cache：现场读不到，用上次成功读到的缓存（并提示核对）
 * - config：完全没有缓存，退回 feishu-table.json 的列序（必须粘到「工作台粘贴」视图）
 */
export type PasteColumnsSource = "live" | "cache" | "config"

export type PasteColumnsResolution =
  | { source: "live"; name: string; columns: string[] }
  | { source: "cache"; name: string; columns: string[]; readAt: string }
  | { source: "config"; name: string }

/** 现场读取失败 → 缓存 → 配置列序，三级兜底。纯函数，便于单测。 */
export function resolvePasteColumns(input: {
  viewName: string
  live: ViewColumnsInput | null | undefined
  cached?: { columns: ViewColumnsInput; readAt: string } | null
}): PasteColumnsResolution {
  const live = input.live ? viewColumnNames(input.live).filter(Boolean) : []
  if (live.length) return { source: "live", name: input.viewName, columns: live }

  const cached = input.cached ? viewColumnNames(input.cached.columns).filter(Boolean) : []
  if (cached.length) {
    return { source: "cache", name: input.viewName, columns: cached, readAt: input.cached?.readAt ?? "" }
  }

  return { source: "config", name: input.viewName }
}

/** 缓存兜底提示：必须让用户知道「这是旧列序，改过视图要核对」。 */
export function cacheFallbackNotice(viewName: string, readAt: string): string {
  const day = readAt.length >= 10 ? readAt.slice(5, 10) : readAt
  return `飞书暂时读不到，已按 ${day} 读取的「${viewName}」列序复制；如果这之后改过视图，请核对`
}

/** 配置列序兜底提示：只能粘到固定列序的「工作台粘贴」视图。 */
export function configFallbackNotice(viewName: string): string {
  return `读不到视图「${viewName}」，已按配置列序复制，请粘到「工作台粘贴」视图`
}

/** 复制成功后的提示。列序来源不同，要粘的目标视图也不同。 */
export function copySuccessNotice(
  source: PasteColumnsSource | null,
  viewName: string | null,
  count = 1,
): string {
  const rows = count > 1 ? ` ${count} 行` : ""
  if (source === "config" || !viewName) {
    return `已复制${rows}（按配置列序）。请粘到飞书「工作台粘贴」视图，选中一行的第一个单元格粘贴`
  }
  return `已复制${rows}（按「${viewName}」的列序）。请到飞书「${viewName}」视图里，选中一行的第一个单元格粘贴——粘到别的视图会错位`
}

export type PasteViewConfigParse =
  | { ok: true; setting: PasteViewSetting | null }
  | { ok: false; error: string }

const CONFIG_BROKEN = "配置文件损坏，请重新选择视图"

function configStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const list = raw.map((x) => String(x ?? "").trim()).filter(Boolean)
  return list.length ? list : undefined
}

/**
 * 解析 paste-view.json。文件不存在（null）算「没设置」；文件存在但解析不了算损坏，
 * 设置页必须让用户重选，不能静默当成没设置（评审要求）。
 */
export function parsePasteViewConfigText(text: string | null): PasteViewConfigParse {
  if (text === null) return { ok: true, setting: null }

  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    return { ok: false, error: CONFIG_BROKEN }
  }
  if (!raw || typeof raw !== "object") return { ok: false, error: CONFIG_BROKEN }

  const obj = raw as Record<string, unknown>
  const viewId = typeof obj.viewId === "string" ? obj.viewId.trim() : ""
  const viewName = typeof obj.viewName === "string" ? obj.viewName.trim() : ""
  if (!viewId || !viewName) return { ok: false, error: CONFIG_BROKEN }

  return {
    ok: true,
    setting: {
      viewId,
      viewName,
      updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined,
      columns: configStringList(obj.columns),
      columnsReadAt: typeof obj.columnsReadAt === "string" ? obj.columnsReadAt : undefined,
    },
  }
}

