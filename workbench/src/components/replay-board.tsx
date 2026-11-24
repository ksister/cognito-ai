"use client"

import { useMemo, useState } from "react"
import { Search } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { ReplayStatus } from "@/lib/replay-model"
import { filterReplayRows, statusLabel, type ReplayListRow } from "@/lib/replay-model"

export type ReplayRow = ReplayListRow

const STATUS_STYLE: Record<ReplayStatus, string> = {
  untested: "bg-zinc-100 text-zinc-600 border-zinc-200",
  tested: "bg-emerald-50 text-emerald-700 border-emerald-200",
  issue: "bg-amber-50 text-amber-700 border-amber-200",
}

const CHIPS: ReplayStatus[] = ["untested", "tested", "issue"]

function placeholder(kind: "retry" | "qa") {
  toast(kind === "retry" ? "「重新识别」是后续任务 T27，这次只留位置。" : "「模拟问答」是后续任务 T29，这次只留位置。")
}

export function ReplayBoard({ rows }: { rows: ReplayRow[] }) {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState<ReplayStatus | "all">("all")
  const [emptyOnly, setEmptyOnly] = useState(false)
  const [scope, setScope] = useState<"shots" | "all">("shots")

  const counts = useMemo(() => {
    const byStatus: Record<ReplayStatus, number> = { untested: 0, tested: 0, issue: 0 }
    for (const row of rows) byStatus[row.status]++
    return {
      total: rows.length,
      byStatus,
      feishuEmpty: rows.filter((r) => r.feishuEmpty).length,
      withShots: rows.filter((r) => r.screenshotCount > 0).length,
    }
  }, [rows])

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
            {CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => setStatus((cur) => (cur === chip ? "all" : chip))}
                className={cn(
                  "h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors",
                  status === chip ? "border-primary/40 bg-primary/10 text-primary" : "bg-background hover:bg-muted",
                )}
                aria-pressed={status === chip}
              >
                {statusLabel(chip)} {counts.byStatus[chip]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
          <button
            type="button"
            onClick={() => setScope((s) => (s === "shots" ? "all" : "shots"))}
            className="h-7 rounded-lg border bg-background px-2.5 font-medium hover:bg-muted"
            aria-pressed={scope === "shots"}
          >
            {scope === "shots" ? `带截图 ${counts.withShots}` : `全部 ${counts.total}`}
          </button>
          <button
            type="button"
            onClick={() => setEmptyOnly((v) => !v)}
            className={cn(
              "h-7 rounded-lg border px-2.5 font-medium transition-colors",
              emptyOnly ? "border-amber-300 bg-amber-50 text-amber-800" : "bg-background hover:bg-muted",
            )}
            aria-pressed={emptyOnly}
          >
            飞书为空 {counts.feishuEmpty}
          </button>
          <span className="text-muted-foreground">
            筛选后 {visible.length} 条
            {scope === "shots" && counts.total > counts.withShots ? `（另有 ${counts.total - counts.withShots} 条无截图）` : ""}
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
                    {row.feishuEmpty ? " · 飞书为空" : ""}
                  </p>
                </div>
                <Badge variant="outline" className={STATUS_STYLE[row.status]}>
                  {statusLabel(row.status)}
                </Badge>
                <div className="flex shrink-0 gap-1.5">
                  <button
                    type="button"
                    onClick={() => placeholder("retry")}
                    className="h-7 rounded-lg border bg-background px-2.5 text-xs font-medium hover:bg-muted"
                  >
                    重新识别
                  </button>
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
