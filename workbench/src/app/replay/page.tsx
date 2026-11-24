import { PageHeader } from "@/components/bits"
import { ReplayBoard, type ReplayRow } from "@/components/replay-board"
import { ReplayRefresh } from "@/components/replay-refresh"
import { resolveKbRoot } from "@/lib/feishu-schema-load"
import { readReplayManifest, readReplayStatuses } from "@/lib/replay-store"

export const dynamic = "force-dynamic"

/**
 * T26 回放测试列表（D21）：只读 KB_DIR/replay/snapshot/，不连飞书。
 * 断网或 lark-cli 未登录时，已有快照照常打开。
 */
export default async function ReplayPage() {
  const kbDir = resolveKbRoot()
  const [state, statuses] = await Promise.all([readReplayManifest(kbDir), readReplayStatuses(kbDir)])

  if (!state.ok) {
    return (
      <>
        <PageHeader title="回放测试" description="从正式表只读生成的本地快照；页面本身不连飞书。" />
        <div className="mb-3 rounded-xl border border-dashed px-4 py-6 text-sm text-destructive">{state.error}</div>
        <ReplayRefresh snapshotAt={null} recordCount={0} shotCount={0} />
      </>
    )
  }

  const manifest = state.manifest
  const rows: ReplayRow[] = (manifest?.records ?? []).map((r) => ({
    r: r.r,
    title: r.title,
    customer: r.customer,
    date: r.date,
    screenshotCount: r.screenshotCount,
    feishuEmpty: r.feishuEmpty,
    status: statuses.get(r.recordId) ?? "untested",
  }))

  return (
    <>
      <PageHeader
        title="回放测试"
        description="从飞书正式表只读生成的快照。这个阶段只做列表：重新识别（T27）和模拟问答（T29）先占位。"
      />
      <ReplayRefresh
        snapshotAt={manifest?.updatedAt ?? null}
        recordCount={manifest?.counts.records ?? 0}
        shotCount={manifest?.counts.shots ?? 0}
      />
      <ReplayBoard rows={rows} />
    </>
  )
}
