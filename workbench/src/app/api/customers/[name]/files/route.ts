import { saveFile } from "@/lib/kb"

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  const form = await req.formData()
  const saved: string[] = []
  for (const f of form.getAll("files")) {
    if (typeof f === "string") continue
    saved.push(await saveFile(decodeURIComponent(name), f.name, Buffer.from(await f.arrayBuffer())))
  }
  return Response.json({ saved })
}
