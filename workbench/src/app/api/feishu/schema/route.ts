import { loadFeishuSchemaState } from "@/lib/feishu-schema-load"

export async function GET() {
  const state = await loadFeishuSchemaState()
  if (!state.ok) return Response.json(state, { status: 400 })
  return Response.json(state)
}
