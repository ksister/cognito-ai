import "server-only"
import { loadFeishuSchemaState } from "./feishu-schema-load"
import { readFeishuViewColumns } from "./lark-view"
import { hiddenSchemaColumns, placeholderViewColumns, resolvePasteColumns, viewColumnNames } from "./paste-view"
import { cacheViewColumns, loadPasteViewConfig } from "./paste-view-config"

/** Shared shape for GET /api/feishu/paste-view and the server-rendered settings page. */
export type PasteViewState = {
  ok: true
  configured: boolean
  broken: boolean
  source: "live" | "cache" | "config" | null
  viewName: string | null
  columns: string[]
  placeholders: string[]
  hidden: string[]
  readAt?: string
  error?: string
}

const EMPTY: PasteViewState = {
  ok: true,
  configured: false,
  broken: false,
  source: null,
  viewName: null,
  columns: [],
  placeholders: [],
  hidden: [],
}

export async function buildPasteViewState(): Promise<PasteViewState> {
  const config = await loadPasteViewConfig()
  if (!config.ok) return { ...EMPTY, broken: true, error: config.error }

  const setting = config.setting
  if (!setting) return EMPTY

  const [read, schemaState] = await Promise.all([
    readFeishuViewColumns(setting.viewId || setting.viewName),
    loadFeishuSchemaState(),
  ])
  const resolution = resolvePasteColumns({
    viewName: setting.viewName,
    live: read.ok ? read.columns : null,
    cached: setting.columns ? { columns: setting.columns, readAt: setting.columnsReadAt ?? "" } : null,
  })

  if (resolution.source === "live") await cacheViewColumns(resolution.columns)

  if (resolution.source === "config") {
    return {
      ...EMPTY,
      configured: true,
      source: "config",
      viewName: setting.viewName,
      error: read.ok ? "这个视图没有可见列" : read.error,
    }
  }

  const columns = viewColumnNames(resolution.columns)
  const schema = schemaState.ok ? schemaState.schema : null
  return {
    ok: true,
    configured: true,
    broken: false,
    source: resolution.source,
    viewName: resolution.name,
    columns,
    placeholders: schema ? placeholderViewColumns(columns, schema) : [],
    hidden: schema ? hiddenSchemaColumns(columns, schema) : [],
    readAt: resolution.source === "cache" ? resolution.readAt : undefined,
    error: schemaState.ok ? undefined : schemaState.error,
  }
}
