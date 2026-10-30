import { getRecord, updateRecord } from "@/lib/kb"
import { pushSavedRecord } from "@/lib/feishu-record-push"
import type { RecordDraft } from "@/lib/types"

type Ctx = { params: Promise<{ customer: string; file: string }> }

type PutBody = Partial<RecordDraft> & {
  feishuSynced?: boolean
  feishuRecordId?: string
  feishuSyncedAt?: string
  feishuAttached?: string[]
  syncFeishu?: boolean
  feishu?: { push?: boolean; handlerOpenIds?: string[]; companyOption?: string }
}

export async function GET(_req: Request, { params }: Ctx) {
  const { customer, file } = await params
  const rec = await getRecord(decodeURIComponent(customer), decodeURIComponent(file))
  return rec ? Response.json(rec) : Response.json({ error: "记录不存在" }, { status: 404 })
}

export async function PUT(req: Request, { params }: Ctx) {
  const { customer, file } = await params
  const body = (await req.json()) as PutBody
  const syncFeishu = body.syncFeishu === true || body.feishu?.push === true
  const feishuSide = body.feishu
  const patch: PutBody = { ...body }
  delete patch.syncFeishu
  delete patch.feishu
  try {
    const saved = await updateRecord(decodeURIComponent(customer), decodeURIComponent(file), patch)
    if (!syncFeishu) return Response.json(saved)
    const pushed = await pushSavedRecord(saved, {
      handlerOpenIds: feishuSide?.handlerOpenIds,
      companyOption: feishuSide?.companyOption,
    })
    return Response.json({ ...pushed.record, feishu: pushed.feishu })
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 })
  }
}
