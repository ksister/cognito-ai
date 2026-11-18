"use client"

import { useState } from "react"
import { AlertTriangle, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { selectClass } from "@/components/bits"

export type PickerView = { name: string; columnCount: number | null }

export type PickerState = {
  configured: boolean
  broken: boolean
  source: "live" | "cache" | "config" | null
  viewName: string | null
  columns: string[]
  placeholders: string[]
  hidden: string[]
  readAt?: string
  error?: string
}

type Props = {
  views: PickerView[]
  viewError: string | null
  initialViewName: string | null
  initialState: PickerState
}

export function PasteViewPicker({ views, viewError, initialViewName, initialState }: Props) {
  const [selected, setSelected] = useState(initialViewName ?? "")
  const [state, setState] = useState<PickerState>(initialState)
  const [busy, setBusy] = useState(false)

  async function choose(viewName: string) {
    if (!viewName || viewName === selected) return
    setBusy(true)
    try {
      const res = await fetch("/api/feishu/paste-view", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viewName }),
      })
      const data = (await res.json()) as PickerState & { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? `保存失败（HTTP ${res.status}）`)
        return
      }
      setSelected(viewName)
      setState({
        configured: data.configured,
        broken: data.broken,
        source: data.source,
        viewName: data.viewName,
        columns: data.columns ?? [],
        placeholders: data.placeholders ?? [],
        hidden: data.hidden ?? [],
        readAt: data.readAt,
        error: data.error,
      })
      toast.success(`已设为「${viewName}」`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">粘贴用的视图</span>
        <select
          aria-label="粘贴用的视图"
          className={`${selectClass} w-64`}
          value={selected}
          disabled={busy}
          onChange={(e) => void choose(e.target.value)}
        >
          <option value="">未选择（按配置列序复制）</option>
          {views.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}
              {v.columnCount ? `（${v.columnCount} 列）` : ""}
            </option>
          ))}
          {selected && !views.some((v) => v.name === selected) && <option value={selected}>{selected}</option>}
        </select>
      </label>

      {viewError && <p className="text-sm text-amber-800">读取视图列表失败：{viewError}</p>}

      {state.broken && (
        <p className="text-sm text-rose-700">
          配置文件损坏，请重新选择视图：{state.error}。选一个视图会覆盖这个文件里的设置。
        </p>
      )}

      {!state.broken && !state.configured && (
        <p className="text-sm text-muted-foreground">
          还没有选择视图。「复制为飞书行」会按 <code className="text-xs">feishu-table.json</code> 的列顺序生成，适合固定
          20 列的专用粘贴视图。选一个你平时用的视图后，会按它的可见列顺序生成。
        </p>
      )}

      {state.configured && state.source === "config" && (
        <p className="text-sm text-rose-700">
          读不到视图「{state.viewName}」：{state.error}。现在复制会退回按配置列序生成（只能粘到「工作台粘贴」视图），并在界面上提示。
        </p>
      )}

      {state.configured && state.source === "cache" && (
        <p className="text-sm text-amber-800">
          飞书暂时读不到这个视图，下面用的是 {state.readAt || "上次"} 读到的缓存列序。改过视图的话请核对。
        </p>
      )}

      {state.columns.length > 0 && (
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

      {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
    </div>
  )
}
