import { saveProfile } from "@/lib/kb"
import type { CustomerProfile } from "@/lib/types"

export async function PUT(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  const profile = (await req.json()) as CustomerProfile
  try {
    await saveProfile({ ...profile, name: decodeURIComponent(name) })
    return Response.json({ ok: true })
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 })
  }
}
