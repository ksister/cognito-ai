import { createRecord, listRecords, saveScreenshotBatch } from "@/lib/kb"
import { compressImageBuffer } from "@/lib/vl"
import type { RecordDraft } from "@/lib/types"

export async function GET() {
  return Response.json(await listRecords())
}

export async function POST(req: Request) {
  const ctype = req.headers.get("content-type") ?? ""
  try {
    if (ctype.includes("multipart/form-data")) {
      const form = await req.formData()
      const draftRaw = form.get("draft")
      if (typeof draftRaw !== "string") {
        return Response.json({ error: "缺少 draft" }, { status: 400 })
      }
      const draft = JSON.parse(draftRaw) as RecordDraft
      if (!draft.customer?.trim()) return Response.json({ error: "请填写客户" }, { status: 400 })
      const rec = await createRecord(draft)
      const files = form.getAll("screenshots").filter((f): f is File => typeof f !== "string")
      if (files.length) {
        const bufs: Buffer[] = []
        for (const f of files) {
          const raw = Buffer.from(await f.arrayBuffer())
          // 落盘前再压成 JPEG，文件名约定为 .jpg
          bufs.push(await compressImageBuffer(raw, { maxEdge: 2560, quality: 88, maxBytes: 4_000_000 }))
        }
        const saved = await saveScreenshotBatch(rec.customer, bufs)
        return Response.json({ ...rec, screenshots: saved })
      }
      return Response.json(rec)
    }

    const draft = (await req.json()) as RecordDraft
    if (!draft.customer?.trim()) return Response.json({ error: "请填写客户" }, { status: 400 })
    return Response.json(await createRecord(draft))
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 })
  }
}
