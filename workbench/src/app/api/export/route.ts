import { listRecords } from "@/lib/kb"
import { toCsv } from "@/lib/feishu"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const scope = url.searchParams.get("scope")
  const customer = url.searchParams.get("customer") ?? undefined
  let records = await listRecords(customer)
  if (scope === "unsynced") records = records.filter((r) => !r.feishuSynced)
  records.sort((a, b) => a.date.localeCompare(b.date))
  const name = encodeURIComponent(`技术支持记录-${scope === "unsynced" ? "未同步" : "全部"}.csv`)
  return new Response(toCsv(records), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${name}`,
    },
  })
}
