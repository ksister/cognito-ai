import Link from "next/link"
import { notFound } from "next/navigation"
import { ChevronLeft } from "lucide-react"
import { PageHeader } from "@/components/bits"
import { ReplayCompare } from "@/components/replay-compare"
import { loadFeishuSchemaState, resolveKbRoot } from "@/lib/feishu-schema-load"
import { isValidReplayR } from "@/lib/replay-model"
import { deriveRunState, isSafeRecordId } from "@/lib/replay-result"
import { listRuns } from "@/lib/replay-results-store"
import { readRecordDetail } from "@/lib/replay-store"
import { feishuFieldsFromDetail } from "@/lib/replay-run"

export const dynamic = "force-dynamic"

/** T27 对比界面：左侧飞书原记录、右侧最近一次重新识别的结果。只读快照和本地结果，不连飞书。 */
export default async function ReplayRecordPage({ params }: { params: Promise<{ r: string }> }) {
  const { r } = await params
  if (!isValidReplayR(r)) notFound()
  const kbDir = resolveKbRoot()
  const detail = await readRecordDetail(kbDir, r)
  if (!detail) notFound()
  // 记录 ID 会拼进 replay/results/<记录 ID>/，格式不对就当没有这条记录。
  if (!isSafeRecordId(detail.recordId)) notFound()

  const [runs, schemaState] = await Promise.all([listRuns(kbDir, detail.recordId), loadFeishuSchemaState()])
  const left = feishuFieldsFromDetail(detail)
  const fieldsComplete = Boolean(detail.fields && Object.keys(detail.fields).length)

  // 列序：表结构配置的顺序；配置读不出来时用快照/结果里出现过的 key。
  const keys = schemaState.ok
    ? schemaState.schema.columns.map((c) => c.key).filter((k): k is string => Boolean(k))
    : [...new Set([...Object.keys(left), ...runs.flatMap((run) => Object.keys(run.fields))])]

  const state = deriveRunState(runs)

  return (
    <>
      <Link href="/replay" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" />
        回放测试
      </Link>
      <PageHeader
        title={`${detail.r} · ${detail.title || "（无问题名称）"}`}
        description="左边是飞书原记录（快照），右边是重新识别的结果。只改本地的结果文件，不会写飞书、也不会动原记录。"
      />
      <ReplayCompare
        record={{
          r: detail.r,
          recordId: detail.recordId,
          title: detail.title,
          date: detail.date,
          customer: detail.customer,
          screenshotCount: detail.shots.length,
          fieldsComplete,
        }}
        keys={keys}
        left={left}
        runs={runs}
        state={state}
      />
    </>
  )
}
