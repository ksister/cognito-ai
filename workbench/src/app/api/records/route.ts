import { createRecord, listRecords, saveScreenshotBatch, updateRecord } from "@/lib/kb"
import { recordKey, setFeishuJob } from "@/lib/feishu-jobs"
import { queueSavedRecordPush } from "@/lib/feishu-record-push"
import { compressImageBuffer } from "@/lib/vl"
import type { FeishuPushPending, RecordDraft } from "@/lib/types"

export async function GET() {
  return Response.json(await listRecords())
}

type FeishuSide = {
  companyOption?: string
  handlerOpenIds?: string[]
  /** When false, skip Feishu push (local only). Default true on create. */
  push?: boolean
}

function parseFeishuSide(raw: unknown): FeishuSide {
  if (!raw || typeof raw !== "object") return {}
  const o = raw as FeishuSide
  return {
    companyOption: typeof o.companyOption === "string" ? o.companyOption : undefined,
    handlerOpenIds: Array.isArray(o.handlerOpenIds)
      ? o.handlerOpenIds.map(String).filter(Boolean)
      : undefined,
    push: o.push,
  }
}

export async function POST(req: Request) {
  const ctype = req.headers.get("content-type") ?? ""
  try {
    let draft: RecordDraft
    const screenshotBufs: Buffer[] = []
    let side: FeishuSide = {}

    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData()
      const draftRaw = form.get("draft")
      if (typeof draftRaw !== "string") {
        return Response.json({ error: "缺少 draft" }, { status: 400 })
      }
      draft = JSON.parse(draftRaw) as RecordDraft
      const feishuRaw = form.get("feishu")
      if (typeof feishuRaw === "string" && feishuRaw.trim()) {
        side = parseFeishuSide(JSON.parse(feishuRaw))
      }
      // 客户可以留空：本地归「待确认」，飞书写「其他-待确认」（D16）
      const files = form.getAll("screenshots").filter((f): f is File => typeof f !== "string")
      for (const f of files) {
        const raw = Buffer.from(await f.arrayBuffer())
        screenshotBufs.push(await compressImageBuffer(raw, { maxEdge: 2560, quality: 88, maxBytes: 4_000_000 }))
      }
    } else {
      const body = (await req.json()) as RecordDraft & { feishu?: FeishuSide }
      const { feishu, ...rest } = body
      draft = rest
      side = parseFeishuSide(feishu)
      // 客户可以留空：本地归「待确认」，飞书写「其他-待确认」（D16）
    }

    // 1) Local disk — never rolled back on Feishu failure
    const rec = await createRecord(draft)
    let screenshots: string[] = []
    if (screenshotBufs.length) {
      screenshots = await saveScreenshotBatch(rec.customer, screenshotBufs, {
        date: rec.date,
        title: rec.title,
      })
      const saved = await updateRecord(rec.customer, rec.file.replace(/\.md$/, ""), { screenshots })
      rec.screenshots = saved.screenshots
    }

    const wantPush = side.push !== false
    let feishu: FeishuPushPending | undefined
    if (wantPush) {
      // D19 save-and-return: the local record is already saved; push to Feishu in the background.
      // The answer is `{pending:true}` — the write is not done yet, the UI shows 「写入中」
      // and polls /api/feishu/status. Pushes for one record are queued (T11 review 1).
      const key = recordKey(rec.customer, rec.file)
      setFeishuJob(key, "writing")
      feishu = { pending: true }
      void queueSavedRecordPush(rec.customer, rec.file, {
        companyOption: side.companyOption,
        handlerOpenIds: side.handlerOpenIds,
      }).catch(() => {
        // The failure is already recorded in the job status; the local record stays.
      })
    }

    return Response.json({ ...rec, screenshots: rec.screenshots, feishu })
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 })
  }
}
