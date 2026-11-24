import { applyReplaySnapshot, planReplaySnapshot, replayConfigFromEnv } from "@/lib/replay-snapshot"
import { planReportLines } from "@/lib/replay-model"

export const dynamic = "force-dynamic"
export const maxDuration = 900

/** 预览：只读飞书 + 只读本地，什么文件都不写。 */
export async function GET() {
  const state = replayConfigFromEnv()
  if (!state.ok) return Response.json({ ok: false, error: state.error }, { status: 400 })
  try {
    const plan = await planReplaySnapshot(state.cfg)
    return Response.json({ ok: true, numbers: plan.numbers, lines: planReportLines(plan.numbers) })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}

/** 执行：必须显式 confirm，否则不写任何东西。 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { confirm?: unknown }
  if (body?.confirm !== true) {
    return Response.json({ ok: false, error: "先看预览、确认后再执行（需要 confirm: true）" }, { status: 400 })
  }
  const state = replayConfigFromEnv()
  if (!state.ok) return Response.json({ ok: false, error: state.error }, { status: 400 })
  try {
    const result = await applyReplaySnapshot(state.cfg)
    const checked = result.fingerprintAfter !== ""
    return Response.json({
      ok: true,
      result: {
        records: result.records,
        written: result.written,
        unchanged: result.unchanged,
        shots: result.shots,
        mediaCopied: result.mediaCopied,
        transcriptsCopied: result.transcriptsCopied,
        transcribed: result.transcribed,
        failures: result.failures,
        fingerprintChecked: checked,
        fingerprintMatch: checked && result.fingerprintAfter === result.plan.fingerprint,
      },
    })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
