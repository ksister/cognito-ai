import { loadFeishuSchemaState } from "@/lib/feishu-schema-load"
import { listFeishuViews, readFeishuViewColumns } from "@/lib/lark-view"
import { loadPasteViewSetting, savePasteViewSetting } from "@/lib/paste-view-config"
import { hiddenSchemaColumns, placeholderViewColumns, viewColumnNames } from "@/lib/paste-view"

export const dynamic = "force-dynamic"

type PasteViewState = {
  ok: true
  configured: boolean
  readable: boolean
  viewName: string | null
  columns: string[]
  placeholders: string[]
  hidden: string[]
  error?: string
}

async function stateFor(viewName: string | null, viewIdOrName: string | null): Promise<PasteViewState> {
  const schemaState = await loadFeishuSchemaState()
  if (!viewName || !viewIdOrName) {
    return { ok: true, configured: false, readable: false, viewName: null, columns: [], placeholders: [], hidden: [] }
  }
  if (!schemaState.ok) {
    return {
      ok: true,
      configured: true,
      readable: false,
      viewName,
      columns: [],
      placeholders: [],
      hidden: [],
      error: schemaState.error,
    }
  }
  const read = await readFeishuViewColumns(viewIdOrName)
  if (!read.ok) {
    return {
      ok: true,
      configured: true,
      readable: false,
      viewName,
      columns: [],
      placeholders: [],
      hidden: [],
      error: read.error,
    }
  }
  const columns = viewColumnNames(read.columns)
  return {
    ok: true,
    configured: true,
    readable: true,
    viewName,
    columns,
    placeholders: placeholderViewColumns(columns, schemaState.schema),
    hidden: hiddenSchemaColumns(columns, schemaState.schema),
  }
}

export async function GET() {
  const setting = await loadPasteViewSetting()
  if (!setting) return Response.json(await stateFor(null, null))
  return Response.json(await stateFor(setting.viewName, setting.viewId || setting.viewName))
}

/** Pick a view by name; the id is resolved on the server and stays there. */
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { viewName?: unknown }
  const viewName = typeof body.viewName === "string" ? body.viewName.trim() : ""
  if (!viewName) return Response.json({ error: "请选择视图" }, { status: 400 })

  const listed = await listFeishuViews()
  if (!listed.ok) return Response.json({ error: listed.error }, { status: 400 })
  const found = listed.views.find((v) => v.name === viewName)
  if (!found) return Response.json({ error: `测试表里没有视图「${viewName}」，请刷新后重选` }, { status: 404 })

  const read = await readFeishuViewColumns(viewName)
  if (!read.ok) return Response.json({ error: `视图读不到，没有保存：${read.error}` }, { status: 400 })

  const setting = await savePasteViewSetting({ viewId: found.id || found.name, viewName: found.name })
  const state = await stateFor(setting.viewName, setting.viewId)
  return Response.json({ ...state, saved: true })
}
