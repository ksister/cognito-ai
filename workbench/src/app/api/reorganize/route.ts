import { reorganizeRecord } from "@/lib/ai"
import { FeishuSchemaError } from "@/lib/feishu-schema"
import type { RecordDraft } from "@/lib/types"

export async function POST(req: Request) {
  let body: { chat?: string; notes?: string[]; draft?: RecordDraft }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 })
  }
  if (!body.draft) return Response.json({ error: "缺少草稿" }, { status: 400 })
  try {
    const notes = Array.isArray(body.notes) ? body.notes.map((n) => String(n ?? "")) : []
    const result = await reorganizeRecord(String(body.chat ?? ""), notes, body.draft)
    return Response.json(result)
  } catch (e) {
    if (e instanceof FeishuSchemaError) {
      return Response.json({ error: e.message, code: "feishu_schema" }, { status: 400 })
    }
    return Response.json({ error: `整理失败：${(e as Error).message}` }, { status: 500 })
  }
}
