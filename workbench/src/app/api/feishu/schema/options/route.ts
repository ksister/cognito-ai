import { listFeishuFieldOptions } from "@/lib/lark-bitable"
import { loadFeishuSchemaState, previewFeishuOptionSync, writeFeishuOptionSync } from "@/lib/feishu-schema-load"

export async function POST(req: Request) {
  const state = await loadFeishuSchemaState()
  if (!state.ok) return Response.json({ error: state.error }, { status: 400 })
  const body = (await req.json().catch(() => ({}))) as { apply?: boolean }
  const listed = await listFeishuFieldOptions()
  if (!listed.ok) return Response.json({ error: listed.error }, { status: 400 })
  const preview = body.apply
    ? await writeFeishuOptionSync(listed.fields)
    : await previewFeishuOptionSync(listed.fields)
  return Response.json({ applied: Boolean(body.apply), ...preview })
}
