import { feishuClipboard, type PasteView } from "@/lib/feishu"
import { loadFeishuSchemaState } from "@/lib/feishu-schema-load"
import { ensureLocalIds } from "@/lib/kb"
import { readFeishuViewColumns } from "@/lib/lark-view"
import {
  cacheFallbackNotice,
  resolvePasteColumns,
  type PasteColumnsSource,
} from "@/lib/paste-view"
import { cacheViewColumns, loadPasteViewConfig } from "@/lib/paste-view-config"

export const dynamic = "force-dynamic"

type ViewInfo = {
  configured: boolean
  source: PasteColumnsSource | null
  name?: string
  readAt?: string
  fallback?: string
}

async function resolveView(): Promise<{ view: PasteView | null; info: ViewInfo }> {
  const state = await loadPasteViewConfig()
  if (!state.ok) {
    return {
      view: null,
      info: {
        configured: false,
        source: "config",
        fallback: state.error,
      },
    }
  }

  const setting = state.setting
  if (!setting) return { view: null, info: { configured: false, source: null } }

  const read = await readFeishuViewColumns(setting.viewId || setting.viewName)
  const resolution = resolvePasteColumns({
    viewName: setting.viewName,
    live: read.ok ? read.columns : null,
    cached: setting.columns ? { columns: setting.columns, readAt: setting.columnsReadAt ?? "" } : null,
  })

  if (resolution.source === "live") {
    await cacheViewColumns(resolution.columns)
    return {
      view: { name: resolution.name, columns: resolution.columns.map((name) => ({ name })) },
      info: { configured: true, source: "live", name: resolution.name },
    }
  }

  if (resolution.source === "cache") {
    return {
      view: { name: resolution.name, columns: resolution.columns.map((name) => ({ name })) },
      info: {
        configured: true,
        source: "cache",
        name: resolution.name,
        readAt: resolution.readAt,
        fallback: cacheFallbackNotice(resolution.name, resolution.readAt),
      },
    }
  }

  return {
    view: null,
    info: {
      configured: true,
      source: "config",
      name: setting.viewName,
      fallback: read.ok
        ? `读不到视图「${setting.viewName}」：这个视图没有可见列`
        : `读不到视图「${setting.viewName}」：${read.error}`,
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
