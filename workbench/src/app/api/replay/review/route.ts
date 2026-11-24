import { resolveKbRoot } from "@/lib/feishu-schema-load"
import { isReplayIssueType, isSafeRecordId, isValidRunId } from "@/lib/replay-result"
import { saveRunReview } from "@/lib/replay-results-store"

export const dynamic = "force-dynamic"

type Body = {
  recordId?: unknown
  runId?: unknown
  fields?: unknown
  reviewed?: unknown
}

/** 字段建议只接受字符串和四种问题类型，别的直接丢掉（存盘前在 lib 里还会再洗一遍）。 */
function sanitizeFields(input: unknown): Record<string, { note: string; issue: string | null }> {
  const out: Record<string, { note: string; issue: string | null }> = {}
  if (!input || typeof input !== "object" || Array.isArray(input)) return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const raw = (value ?? {}) as { note?: unknown; issue?: unknown }
    out[key] = {
      note: String(raw?.note ?? ""),
      issue: isReplayIssueType(raw?.issue) ? raw.issue : null,
    }
  }
  return out
}

/**
 * 保存建议 / 问题类型，或点「完成核对」。
 * 只写 KB_DIR/replay/results/<记录>/<运行>.json 里的 review，不碰别的文件。
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body
  const recordId = typeof body.recordId === "string" ? body.recordId : ""
  const runId = typeof body.runId === "string" ? body.runId : ""
  // 拼路径之前在接口这一层先挡一次：飞书记录 ID 只允许字母数字和 _-，运行 ID 是固定格式。
  if (!isSafeRecordId(recordId)) {
    return Response.json({ ok: false, error: "记录 ID 格式不对（只允许字母、数字和 _-）" }, { status: 400 })
  }
  if (!isValidRunId(runId)) {
    return Response.json({ ok: false, error: "缺少记录 ID 或运行 ID" }, { status: 400 })
  }
  try {
    const result = await saveRunReview({
      kbDir: resolveKbRoot(),
      recordId,
      runId,
      fields: sanitizeFields(body.fields),
      reviewed: body.reviewed === true,
    })
    if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 404 })
    return Response.json({
      ok: true,
      review: {
        fieldCount: Object.keys(result.run.review?.fields ?? {}).length,
        reviewedAt: result.run.review?.reviewedAt ?? null,
        updatedAt: result.run.review?.updatedAt ?? null,
      },
    })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
