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

/** 复制前置校验：视图读不到时退回配置列序，调用方负责提示。 */
export type PasteViewResolution =
  | { ok: true; columns: ViewColumn[]; name: string }
  | { ok: false; error: string }
