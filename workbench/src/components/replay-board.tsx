"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Search } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { ReplayStatus } from "@/lib/replay-model"
import { countReplayRows, filterReplayRows, statusLabel, type ReplayListRow } from "@/lib/replay-model"

export type ReplayRow = ReplayListRow

const STATUS_STYLE: Record<ReplayStatus, string> = {
  untested: "bg-zinc-100 text-zinc-600 border-zinc-200",
  tested: "bg-emerald-50 text-emerald-700 border-emerald-200",
  issue: "bg-amber-50 text-amber-700 border-amber-200",
}

const STATUS_TOGGLES: ReplayStatus[] = ["untested", "tested", "issue"]

/** 开关选中用和侧栏选中项一样的浅蓝；关着是普通描边。黄色只留给行内的「飞书为空」标签。 */
function toggleClass(active: boolean) {
  return cn(
    "h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors",
    active ? "border-primary/40 bg-primary/10 text-primary" : "bg-background hover:bg-muted",
  )
}

function placeholder(kind: "qa") {
  toast(kind === "qa" ? "「模拟问答」是后续任务 T29，这次只留位置。" : "")
}

export function ReplayBoard({ rows }: { rows: ReplayRow[] }) {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState<ReplayStatus | "all">("all")
  const [emptyOnly, setEmptyOnly] = useState(false)
  const [scope, setScope] = useState<"shots" | "all">("shots")

  // 数字跟着当前范围走：带截图模式下只统计带截图的记录。
  const counts = useMemo(() => countReplayRows(rows, scope), [rows, scope])

  const visible = useMemo(
    () => filterReplayRows(rows, { q, status, emptyOnly, scope }),
    [rows, q, status, emptyOnly, scope],
  )

  return (
    <Card className="py-0">
      <CardContent className="px-0">
        <div className="flex flex-col gap-2 border-b px-3 py-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索：R 编号、标题、客户、日期"
              className="bg-background pl-8"
              aria-label="搜索回放记录"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setEmptyOnly((v) => !v)} className={toggleClass(emptyOnly)} aria-pressed={emptyOnly}>
              飞书为空 {counts.feishuEmpty}
            </button>
            {STATUS_TOGGLES.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => setStatus((cur) => (cur === chip ? "all" : chip))}
                className={toggleClass(status === chip)}
                aria-pressed={status === chip}
              >
                {statusLabel(chip)} {counts.byStatus[chip]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
          <div className="flex items-center" role="group" aria-label="显示范围">
            <button
              type="button"
              onClick={() => setScope("shots")}
              aria-pressed={scope === "shots"}
              className={cn(
                "h-7 rounded-l-lg border px-2.5 font-medium transition-colors",
                scope === "shots" ? "border-primary/40 bg-primary/10 text-primary" : "bg-background hover:bg-muted",
              )}
            >
              带截图 {counts.withScreenshots}
            </button>
            <button
              type="button"
              onClick={() => setScope("all")}
              aria-pressed={scope === "all"}
              className={cn(
                "h-7 rounded-r-lg border border-l-0 px-2.5 font-medium transition-colors",
                scope === "all" ? "border-primary/40 bg-primary/10 text-primary" : "bg-background hover:bg-muted",
              )}
            >
              全部 {counts.total}
            </button>
          </div>
          <span className="text-muted-foreground">
            筛选后 {visible.length} 条{status !== "all" ? `（只显示「${statusLabel(status)}」）` : ""}
          </span>
        </div>

        {visible.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {rows.length === 0 ? "快照里还没有记录，先点右上角「刷新快照」。" : "没有符合条件的记录，换个关键词或清掉筛选。"}
          </p>
        ) : (
          <ul className="divide-y">
            {visible.map((row) => (
              <li key={row.r} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 hover:bg-muted/40">
                <span className="w-14 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{row.r}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{row.title || "（无问题名称）"}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[row.customer || "（无客户）", row.date || "（无日期）", `截图 ${row.screenshotCount}`].join(" · ")}
                  </p>
                </div>
                {row.feishuEmpty && (
                  <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                    飞书为空
                  </Badge>
                )}
                {row.pendingReview && (
                  <Badge variant="outline" className="border-sky-200 bg-sky-50 text-sky-700">
                    有新结果待核对
                  </Badge>
                )}
                <Badge variant="outline" className={STATUS_STYLE[row.status]}>
                  {statusLabel(row.status)}
                </Badge>
                <div className="flex shrink-0 gap-1.5">
                  <Link
                    href={`/replay/${row.r}`}
                    className="inline-flex h-7 items-center rounded-lg border bg-background px-2.5 text-xs font-medium hover:bg-muted"
                  >
                    重新识别
                  </Link>
                  <button
                    type="button"
                    onClick={() => placeholder("qa")}
                    className="h-7 rounded-lg border bg-background px-2.5 text-xs font-medium hover:bg-muted"
                  >
                    模拟问答
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
