import { listFeishuViews, readFeishuViewColumns } from "@/lib/lark-view"
import { viewColumnNames } from "@/lib/paste-view"
import { savePasteViewSetting } from "@/lib/paste-view-config"
import { buildPasteViewState } from "@/lib/paste-view-state"

export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json(await buildPasteViewState())
}

/** Pick a view by name; the id is resolved on the server and stays there. */
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { viewName?: unknown }
  const viewName = typeof body.viewName === "string" ? body.viewName.trim() : ""
  if (!viewName) return Response.json({ error: "请选择视图" }, { status: 400 })

  const listed = await listFeishuViews()
  if (!listed.ok) return Response.json({ error: listed.error }, { status: 400 })
  const found = listed.views.find((v) => v.name === viewName)
  if (!found) return Response.json({ error: `没有视图「${viewName}」，请刷新后重选` }, { status: 404 })

  const read = await readFeishuViewColumns(viewName)
  if (!read.ok) return Response.json({ error: `视图读不到，没有保存：${read.error}` }, { status: 400 })

  const columns = viewColumnNames(read.columns)
  await savePasteViewSetting({ viewId: found.id || found.name, viewName: found.name, columns })

  const state = await buildPasteViewState()
  return Response.json({ ...state, saved: true })
}
