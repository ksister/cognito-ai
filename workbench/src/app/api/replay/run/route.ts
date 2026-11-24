import { resolveKbRoot } from "@/lib/feishu-schema-load"
import { isValidReplayR } from "@/lib/replay-model"
import { listRuns } from "@/lib/replay-results-store"
import { previewReorganize, runReorganize, type ReorganizePreview } from "@/lib/replay-run"
import { readRecordDetail } from "@/lib/replay-store"

export const dynamic = "force-dynamic"
export const maxDuration = 300

async function loadDetail(r: unknown) {
  if (!isValidReplayR(r)) return { error: "R 编号不合法（例如 R153）", status: 400 as const }
  const kbDir = resolveKbRoot()
  const detail = await readRecordDetail(kbDir, r as string)
  if (!detail) return { error: "快照里没有这条记录，先刷新快照", status: 404 as const }
  return { kbDir, detail }
}

/**
 * 预览：这条记录重跑一次要花多少钱。
 * 只读快照和配置，不调模型、不写文件。必须在真正跑之前给用户看。
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const loaded = await loadDetail(url.searchParams.get("r"))
  if ("error" in loaded) return Response.json({ ok: false, error: loaded.error }, { status: loaded.status })
  const { kbDir, detail } = loaded
  try {
    const runs = await listRuns(kbDir, detail.recordId)
    const preview: ReorganizePreview = await previewReorganize({ kbDir, detail, previousRuns: runs.length })
    return Response.json({
      ok: true,
      r: detail.r,
      title: detail.title,
      date: detail.date,
      customer: detail.customer,
      screenshotCount: detail.shots.length,
      preview,
    })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}

/**
 * 执行：先看预览、用户确认（confirm: true）之后才调模型。
 * 只写 KB_DIR/replay/results/；不连飞书。
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { r?: unknown; mode?: unknown; confirm?: unknown }
  const loaded = await loadDetail(body?.r)
  if ("error" in loaded) return Response.json({ ok: false, error: loaded.error }, { status: loaded.status })
  if (body?.mode !== "reorganize") {
    return Response.json({ ok: false, error: "这次只做「只重跑整理」；「从截图重新转写」是 PR2。" }, { status: 400 })
  }
  if (body?.confirm !== true) {
    return Response.json({ ok: false, error: "先看预计费用、确认后再执行（需要 confirm: true）" }, { status: 400 })
  }
  const { kbDir, detail } = loaded
  try {
    const run = await runReorganize({ kbDir, detail })
    return Response.json({
      ok: true,
      run: {
        runId: run.runId,
        at: run.at,
        mode: run.mode,
        model: run.model,
        promptVersion: run.promptVersion,
        durationMs: run.durationMs,
        usage: run.usage,
        costYuan: run.costYuan,
        extractMode: run.extractMode,
        warning: run.warning ?? null,
      },
    })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
