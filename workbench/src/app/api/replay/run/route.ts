import { resolveKbRoot } from "@/lib/feishu-schema-load"
import { isValidReplayR } from "@/lib/replay-model"
import { isSafeRecordId } from "@/lib/replay-result"
import { listRuns } from "@/lib/replay-results-store"
import {
  previewReorganize,
  previewRetranscribe,
  runReorganize,
  runRetranscribe,
  type ReorganizePreview,
  type RetranscribePreview,
} from "@/lib/replay-run"
import { readRecordDetail } from "@/lib/replay-store"

export const dynamic = "force-dynamic"
export const maxDuration = 300

type Mode = "reorganize" | "retranscribe"

function parseMode(v: unknown): Mode | null {
  if (v === "retranscribe") return "retranscribe"
  if (v === "reorganize" || v == null || v === "") return "reorganize"
  return null
}

async function loadDetail(r: unknown) {
  if (!isValidReplayR(r)) return { error: "R 编号不合法（例如 R153）", status: 400 as const }
  const kbDir = resolveKbRoot()
  const detail = await readRecordDetail(kbDir, r as string)
  if (!detail) return { error: "快照里没有这条记录，先刷新快照", status: 404 as const }
  // 记录 ID 要拼进 replay/results/<记录 ID>/：格式不对就不能用（挡 ../ 之类）。
  if (!isSafeRecordId(detail.recordId)) return { error: "快照里的记录 ID 格式不对，先刷新快照", status: 400 as const }
  return { kbDir, detail }
}

/** 通义配置（只给「从截图重新转写」用；只读环境变量，不碰飞书）。 */
function vlConfig() {
  return {
    vlModel: (process.env.DASHSCOPE_VL_MODEL ?? "").trim(),
    dashscopeKey: (process.env.DASHSCOPE_API_KEY ?? "").trim(),
    dashscopeBase: (process.env.DASHSCOPE_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, ""),
  }
}

/**
 * 预览：这次重跑要花多少钱。
 * 只读快照和配置，不调模型、不写文件。必须在真正跑之前给用户看。
 * `?mode=reorganize`（默认）用快照已有转写；`?mode=retranscribe` 从截图重转。
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const mode = parseMode(url.searchParams.get("mode"))
  if (!mode) return Response.json({ ok: false, error: "mode 只能是 reorganize 或 retranscribe" }, { status: 400 })
  const loaded = await loadDetail(url.searchParams.get("r"))
  if ("error" in loaded) return Response.json({ ok: false, error: loaded.error }, { status: loaded.status })
  const { kbDir, detail } = loaded
  try {
    const runs = await listRuns(kbDir, detail.recordId)
    const preview: ReorganizePreview | RetranscribePreview =
      mode === "retranscribe"
        ? await previewRetranscribe({ kbDir, detail, previousRuns: runs.length, vlModel: vlConfig().vlModel })
        : await previewReorganize({ kbDir, detail, previousRuns: runs.length })
    return Response.json({
      ok: true,
      r: detail.r,
      title: detail.title,
      date: detail.date,
      customer: detail.customer,
      screenshotCount: detail.shots.length,
      mode,
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
  const mode = parseMode(body?.mode)
  if (!mode) return Response.json({ ok: false, error: "mode 只能是 reorganize 或 retranscribe" }, { status: 400 })
  const loaded = await loadDetail(body?.r)
  if ("error" in loaded) return Response.json({ ok: false, error: loaded.error }, { status: loaded.status })
  if (body?.confirm !== true) {
    return Response.json({ ok: false, error: "先看预计费用、确认后再执行（需要 confirm: true）" }, { status: 400 })
  }
  const { kbDir, detail } = loaded
  try {
    const cfg = vlConfig()
    const run =
      mode === "retranscribe"
        ? await runRetranscribe({
            kbDir,
            detail,
            vlModel: cfg.vlModel,
            dashscopeKey: cfg.dashscopeKey,
            dashscopeBase: cfg.dashscopeBase,
          })
        : await runReorganize({ kbDir, detail })
    return Response.json({
      ok: true,
      run: {
        runId: run.runId,
        at: run.at,
        mode: run.mode,
        model: run.model,
        promptVersion: run.promptVersion,
        transcriptPromptVersion: run.transcriptPromptVersion ?? null,
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
