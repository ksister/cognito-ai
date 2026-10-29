import { analyzeNeeds, collectNeeds } from "@/lib/ai"
import { listRecords, saveRequirementDoc } from "@/lib/kb"

export async function POST() {
  const rows = collectNeeds(await listRecords())
  if (!rows.length) return Response.json({ error: "还没有需求线索" }, { status: 400 })
  const res = await analyzeNeeds(rows)
  const file = await saveRequirementDoc(res.title, res.markdown)
  return Response.json({ file, mode: res.mode, warning: res.warning })
}
