import { extractRecord } from "@/lib/ai"
import { readProfileContext } from "@/lib/kb"

export async function POST(req: Request) {
  const { chat, customer, me } = (await req.json()) as { chat?: string; customer?: string; me?: string }
  if (!chat?.trim()) return Response.json({ error: "聊天记录为空" }, { status: 400 })
  const profile = await readProfileContext()
  return Response.json(await extractRecord(chat, { customer, me, profile }))
}
