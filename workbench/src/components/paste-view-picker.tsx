"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { selectClass } from "@/components/bits"
import { fetchPasteViewApi, type PasteViewApiState } from "@/lib/paste-view-client"

type ViewSummary = { name: string; columnCount: number | null }

async function fetchViews(): Promise<{ ok: boolean; views: ViewSummary[]; error?: string }> {
  try {
    const res = await fetch("/api/feishu/views")
    const data = (await res.json()) as { ok?: boolean; views?: ViewSummary[]; error?: string }
    if (!res.ok || !data.ok) return { ok: false, views: [], error: data.error ?? `读取视图列表失败（HTTP ${res.status}）` }
    return { ok: true, views: data.views ?? [] }
  } catch (e) {
    return { ok: false, views: [], error: (e as Error).message }
  }
}

export function PasteViewPicker({ initialViewName }: { initialViewName: string | null }) {
  const [views, setViews] = useState<ViewSummary[]>([])
  const [selected, setSelected] = useState(initialViewName ?? "")
  const [state, setState] = useState<PasteViewApiState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [listed, current] = await Promise.all([fetchViews(), fetchPasteViewApi()])
      if (!alive) return
      if (listed.ok) setViews(listed.views)
      else setError(listed.error ?? null)
      if (current) {
        setState(current)
        if (current.viewName) setSelected(current.viewName)
      }
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [])

  async function refresh() {
    setLoading(true)
    setError(null)
    const listed = await fetchViews()
    if (listed.ok) setViews(listed.views)
    else setError(listed.error ?? null)
    const current = await fetchPasteViewApi()
    if (current) {
      setState(current)
      if (current.viewName) setSelected(current.viewName)
    }
    setLoading(false)
  }

  async function choose(viewName: string) {
    if (!viewName) return
    setBusy(true)
    try {
      const res = await fetch("/api/feishu/paste-view", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewName }),
      })
      const data = (await res.json()) as PasteViewApiState & { error?: string }
      if (!res.ok) {
        toast.error(data.error ?? `保存失败（HTTP ${res.status}）`)
        return
      }
      setSelected(viewName)
      setState(data)
      toast.success(`已设为「${viewName}」`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">粘贴用的视图</span>
          <select
            aria-label="粘贴用的视图"
            className={`${selectClass} w-64`}
            value={selected}
            disabled={busy || loading}
            onChange={(e) => void choose(e.target.value)}
          >
            <option value="">{loading ? "正在读取视图…" : "未选择（按配置列序复制）"}</option>
            {views.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
                {v.columnCount ? `（${v.columnCount} 列）` : ""}
              </option>
            ))}
          </select>
        </label>
        <Button variant="outline" size="sm" disabled={busy || loading} onClick={() => void refresh()}>
          <RefreshCw />
          刷新列表
        </Button>
        {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      {error && <p className="text-sm text-amber-800">{error}</p>}

      {state && !state.configured && (
        <p className="text-sm text-muted-foreground">
          还没有选择视图。「复制为飞书行」会按 <code className="text-xs">feishu-table.json</code> 的列顺序生成，适合固定
          20 列的专用粘贴视图。选一个你平时用的视图后，会按它的可见列顺序生成。
        </p>
      )}

      {state?.configured && !state.readable && (
        <p className="text-sm text-rose-700">
          读不到视图「{state.viewName}」：{state.error}。现在复制会退回按配置列序生成，并在界面上提示。
        </p>
      )}

      {state?.readable && (
        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-sm font-medium">
              将按这个顺序输出（{state.columns.length} 列，{state.placeholders.length} 列留空）
            </p>
            <ol className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {state.columns.map((name, i) => {
                const empty = state.placeholders.includes(name)
                return (
                  <li
                    key={`${name}-${i}`}
                    className={`flex items-baseline gap-2 rounded-md border px-2 py-1 text-sm ${
                      empty ? "border-dashed text-muted-foreground" : ""
                    }`}
                  >
                    <span className="w-5 shrink-0 text-right text-xs text-muted-foreground">{i + 1}</span>
                    <span className="truncate">{name}</span>
                    {empty && <span className="ml-auto shrink-0 text-xs">留空</span>}
                  </li>
                )
              })}
            </ol>
          </div>

          {state.hidden.length > 0 && (
            <p className="flex items-start gap-1.5 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                这个视图隐藏了 {state.hidden.length} 列：{state.hidden.join("、")}。这些内容复制时会丢掉，粘贴前请确认。
              </span>
            </p>
          )}

          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              如果这个视图里冻结了列，飞书会把冻结列显示在最左边，粘贴会跟着屏幕顺序走、和上面的顺序不一致。请核对上面第
              1 列和最后一列和你屏幕上看到的一样；对不上就先取消冻结，或换一个没有冻结列的视图。
            </span>
          </p>
        </div>
      )}
    </div>
  )
}
