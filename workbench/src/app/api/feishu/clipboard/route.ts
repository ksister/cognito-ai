import { feishuClipboard } from "@/lib/feishu"
import { loadFeishuSchemaState } from "@/lib/feishu-schema-load"
import { ensureLocalIds } from "@/lib/kb"

export async function POST(req: Request) {
  const state = await loadFeishuSchemaState()
  if (!state.ok) return Response.json({ error: state.error }, { status: 400 })
  const body = (await req.json()) as { ids?: unknown }
  const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : []
  if (!ids.length) return Response.json({ error: "没有要复制的记录" }, { status: 400 })
  const { records, already } = await ensureLocalIds(ids)
  if (!records.length) return Response.json({ error: "找不到这些记录" }, { status: 404 })
  const clip = feishuClipboard(records, state.schema)
  return Response.json({ ...clip, already, records })
}
