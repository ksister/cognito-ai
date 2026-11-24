import { resolveKbRoot } from "@/lib/feishu-schema-load"
import { loadSpeakersSettings, saveSpeakersSettings } from "@/lib/speakers-config"

export const dynamic = "force-dynamic"

/** 当前设置（来源可能是新文件 speakers.json，也可能是旧的 replay.json）。 */
export async function GET() {
  const loaded = await loadSpeakersSettings(resolveKbRoot())
  if (!loaded.ok) return Response.json({ ok: false, error: loaded.error }, { status: 500 })
  return Response.json({
    ok: true,
    myNicknames: loaded.settings.myNicknames,
    companyPrefixes: loaded.settings.companyPrefixes,
    source: loaded.source,
    updatedAt: loaded.settings.updatedAt ?? null,
  })
}

/** 保存到 config/speakers.json；旧文件 replay.json 不动。 */
export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { myNicknames?: unknown; companyPrefixes?: unknown }
  const toText = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) ? v.map(String).join(",") : "")
  try {
    const saved = await saveSpeakersSettings(resolveKbRoot(), {
      myNicknames: toText(body?.myNicknames),
      companyPrefixes: toText(body?.companyPrefixes),
    })
    return Response.json({ ok: true, myNicknames: saved.myNicknames, companyPrefixes: saved.companyPrefixes })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
