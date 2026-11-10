import { getFeishuJob, recordKey } from "@/lib/feishu-jobs"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const customer = url.searchParams.get("customer") ?? ""
  const file = url.searchParams.get("file") ?? ""
  if (!customer || !file) {
    return Response.json({ error: "缺少 customer 或 file" }, { status: 400 })
  }
  const job = getFeishuJob(recordKey(customer, file))
  return Response.json(job ?? { status: "unknown" })
}
