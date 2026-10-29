import { createRecord, listRecords } from "@/lib/kb"
import type { RecordDraft } from "@/lib/types"

export async function GET() {
  return Response.json(await listRecords())
}

export async function POST(req: Request) {
  const draft = (await req.json()) as RecordDraft
  if (!draft.customer?.trim()) return Response.json({ error: "请填写客户" }, { status: 400 })
  try {
    return Response.json(await createRecord(draft))
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 })
  }
}
