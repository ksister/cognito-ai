import { loadReplaySettings, saveMyNicknames } from "@/lib/replay-config"
import { resolveKbRoot } from "@/lib/feishu-schema-load"

export const dynamic = "force-dynamic"

/** 我的昵称（T27 判断发言人、T29 取「我当时的实际回复」都用它）。只存 KB_DIR。 */
export async function GET() {
  const state = await loadReplaySettings(resolveKbRoot())
  if (!state.ok) return Response.json({ ok: false, error: state.error }, { status: 500 })
  return Response.json({ ok: true, myNicknames: state.settings.myNicknames })
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { myNicknames?: unknown }
  const input =
    typeof body.myNicknames === "string"
      ? body.myNicknames
      : Array.isArray(body.myNicknames)
        ? body.myNicknames.map((x) => String(x))
        : null
  if (input === null) return Response.json({ ok: false, error: "请填写昵称（可填多个，用逗号或顿号分隔）" }, { status: 400 })
  try {
    const saved = await saveMyNicknames(resolveKbRoot(), input)
    return Response.json({ ok: true, myNicknames: saved.myNicknames })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
