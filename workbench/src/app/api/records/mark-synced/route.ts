import { updateRecord } from "@/lib/kb"

export async function POST(req: Request) {
  const { ids } = (await req.json()) as { ids: string[] }
  let count = 0
  for (const id of ids ?? []) {
    const slash = id.indexOf("/")
    if (slash < 0) continue
    await updateRecord(id.slice(0, slash), id.slice(slash + 1), { feishuSynced: true })
    count++
  }
  return Response.json({ count })
}
