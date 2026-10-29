import { getRecord, updateRecord } from "@/lib/kb"
import type { RecordDraft } from "@/lib/types"

type Ctx = { params: Promise<{ customer: string; file: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  const { customer, file } = await params
  const rec = await getRecord(decodeURIComponent(customer), decodeURIComponent(file))
  return rec ? Response.json(rec) : Response.json({ error: "记录不存在" }, { status: 404 })
}

export async function PUT(req: Request, { params }: Ctx) {
  const { customer, file } = await params
  const patch = (await req.json()) as Partial<RecordDraft> & { feishuSynced?: boolean }
  try {
    return Response.json(await updateRecord(decodeURIComponent(customer), decodeURIComponent(file), patch))
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 })
  }
}
