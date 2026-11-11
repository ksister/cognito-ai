import { feishuClipboard, type PasteView } from "@/lib/feishu"
import { loadFeishuSchemaState } from "@/lib/feishu-schema-load"
import { ensureLocalIds } from "@/lib/kb"
import { readFeishuViewColumns } from "@/lib/lark-view"
import { loadPasteViewSetting } from "@/lib/paste-view-config"

export const dynamic = "force-dynamic"

type ViewInfo = { configured: boolean; name?: string; fallback?: string }

async function resolveView(): Promise<{ view: PasteView | null; info: ViewInfo }> {
  const setting = await loadPasteViewSetting()
  if (!setting) return { view: null, info: { configured: false } }

  const read = await readFeishuViewColumns(setting.viewId || setting.viewName)
  if (read.ok) {
    return { view: { name: setting.viewName, columns: read.columns }, info: { configured: true, name: setting.viewName } }
  }
  return {
    view: null,
    info: {
      configured: true,
      name: setting.viewName,
      fallback: `读不到视图「${setting.viewName}」，已按 feishu-table.json 的列顺序复制：${read.error}`,
    },
  }
}

export async function POST(req: Request) {
  const state = await loadFeishuSchemaState()
  if (!state.ok) return Response.json({ error: state.error }, { status: 400 })
  const body = (await req.json()) as { ids?: unknown }
  const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : []
  if (!ids.length) return Response.json({ error: "没有要复制的记录" }, { status: 400 })
  const { records, already } = await ensureLocalIds(ids)
  if (!records.length) return Response.json({ error: "找不到这些记录" }, { status: 404 })

  const { view, info } = await resolveView()
  const clip = feishuClipboard(records, state.schema, view)
  const warnings = info.fallback ? [info.fallback, ...clip.warnings] : clip.warnings
  return Response.json({ ...clip, warnings, already, records, view: info })
}
