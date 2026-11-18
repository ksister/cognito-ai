import { listFeishuViews } from "@/lib/lark-view"

export const dynamic = "force-dynamic"

/** Names and column counts only: no view ids, no tokens. */
export async function GET() {
  try {
    const result = await listFeishuViews()
    if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 400 })
    return Response.json({
      ok: true,
      views: result.views.map((v) => ({ name: v.name, columnCount: v.columnCount })),
    })
  } catch (e) {
    return Response.json({ ok: false, error: `读取视图列表失败：${(e as Error).message}` }, { status: 500 })
  }
}
