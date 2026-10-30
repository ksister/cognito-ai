import path from "node:path"
import { createRecord, listRecords, saveScreenshotBatch, updateRecord, KB_ROOT, safeName } from "@/lib/kb"
import { pushRecordToFeishu, type LarkPushResult } from "@/lib/lark-bitable"
import { compressImageBuffer } from "@/lib/vl"
import type { RecordDraft } from "@/lib/types"

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
      if (!draft.customer?.trim()) return Response.json({ error: "请填写客户" }, { status: 400 })
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
      if (!draft.customer?.trim()) return Response.json({ error: "请填写客户" }, { status: 400 })
    }

    // 1) Local disk — never rolled back on Feishu failure
    const rec = await createRecord(draft)
    let screenshots: string[] = []
    if (screenshotBufs.length) {
      screenshots = await saveScreenshotBatch(rec.customer, screenshotBufs)
    }

    const wantPush = side.push !== false
    let feishu: LarkPushResult | undefined
    if (wantPush) {
      const customerSafe = safeName(rec.customer)
      const filesDir = path.join(KB_ROOT, "customers", customerSafe, "files")
      const screenshotFiles = screenshots.map((name) => ({
        name,
        path: path.join(filesDir, name),
      }))
      // 2–3) create (no attach) → upload-attachment via lark-cli (default) or API fallback
      feishu = await pushRecordToFeishu({
        draft: { ...draft, customer: rec.customer, title: rec.title },
        companyOption: side.companyOption,
        handlerOpenIds: side.handlerOpenIds,
        screenshotFiles,
        // API mode may still use buffers if paths missing
        screenshots: screenshots.map((name, i) => ({
          name,
          data: screenshotBufs[i],
        })),
      })
      if (feishu.ok) {
        try {
          await updateRecord(rec.customer, rec.file.replace(/\.md$/, ""), { feishuSynced: true })
          rec.feishuSynced = true
        } catch {
          // local mark-synced is best-effort
        }
      }
    }

    return Response.json({ ...rec, screenshots, feishu })
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 })
  }
}
