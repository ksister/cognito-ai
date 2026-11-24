"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type PlanResponse = { ok?: boolean; lines?: string[]; error?: string }
type ApplyResponse = {
  ok?: boolean
  error?: string
  result?: {
    records: number
    written: number
    unchanged: number
    shots: number
    mediaCopied: number
    transcriptsCopied: number
    transcribed: number
    failures: number
    fingerprintChecked: boolean
    fingerprintMatch: boolean
  }
}

type Phase = "idle" | "planning" | "preview" | "applying" | "done"

/**
 * 「刷新快照」两段式（D21 / 第 0 节规则 5）：先只读预览，用户确认后才写。
 * 预览里只有数量，没有客户名和飞书记录 ID。
 */
export function ReplayRefresh({
  snapshotAt,
  recordCount,
  shotCount,
}: {
  snapshotAt: string | null
  recordCount: number
  shotCount: number
}) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>("idle")
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ApplyResponse["result"] | null>(null)

  async function preview() {
    setPhase("planning")
    setError(null)
    setResult(null)
    try {
      const res = await fetch("/api/replay/snapshot")
      const data = (await res.json()) as PlanResponse
      if (!res.ok || !data.ok) {
        setError(data.error ?? `预览失败（HTTP ${res.status}）`)
        setPhase("idle")
        return
      }
      setLines(data.lines ?? [])
      setPhase("preview")
    } catch (e) {
      setError((e as Error).message)
      setPhase("idle")
    }
  }

  async function apply() {
    setPhase("applying")
    try {
      const res = await fetch("/api/replay/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      })
      const data = (await res.json()) as ApplyResponse
      if (!res.ok || !data.ok || !data.result) {
        setError(data.error ?? `执行失败（HTTP ${res.status}）`)
        setPhase("preview")
        return
      }
      setResult(data.result)
      setPhase("done")
      toast.success(`快照已刷新：${data.result.records} 条记录、${data.result.shots} 张截图`)
      router.refresh()
    } catch (e) {
      setError((e as Error).message)
      setPhase("preview")
    }
  }

  const busy = phase === "planning" || phase === "applying"
  const snapshotText = snapshotAt
    ? `快照更新于 ${new Date(snapshotAt).toLocaleString("zh-CN")} · ${recordCount} 条记录 · ${shotCount} 张截图`
    : "还没有快照：点「刷新快照」从正式表只读生成（先看预览，再确认执行）"

  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{snapshotText}</p>
        <button
          type="button"
          onClick={() => void preview()}
          disabled={busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {phase === "planning" ? "正在读飞书…" : phase === "applying" ? "正在刷新…" : "刷新快照"}
        </button>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="px-4 text-sm text-destructive">刷新没成功：{error}</CardContent>
        </Card>
      )}

      {(phase === "preview" || phase === "applying") && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">刷新预览（还没写任何文件）</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {lines.join("\n")}
            </pre>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void apply()}
                disabled={phase === "applying"}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-60"
              >
                {phase === "applying" && <Loader2 className="size-3.5 animate-spin" />}
                确认执行
              </button>
              <button
                type="button"
                onClick={() => setPhase("idle")}
                disabled={phase === "applying"}
                className="h-8 rounded-lg border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-60"
              >
                取消
              </button>
              <span className="self-center text-xs text-muted-foreground">整轮只读飞书，不会往飞书写任何东西。</span>
            </div>
          </CardContent>
        </Card>
      )}

      {phase === "done" && result && (
        <Card className="border-emerald-200">
          <CardContent className="space-y-1 px-4 text-sm">
            <p className="font-medium">快照已刷新</p>
            <p className="text-muted-foreground">
              记录 {result.records} 条（新写入 {result.written}，未变 {result.unchanged}），截图 {result.shots} 张；本次转写{" "}
              {result.transcribed} 张，复制截图 {result.mediaCopied} 个、转写 {result.transcriptsCopied} 份
              {result.failures > 0 ? `；失败 ${result.failures} 条（明细在快照目录的 last-apply.json）` : ""}。
            </p>
            <p className="text-muted-foreground">
              {result.fingerprintChecked
                ? result.fingerprintMatch
                  ? "只读复核：刷新前后飞书指纹一致，没有写入。"
                  : "只读复核：刷新前后指纹不一致，请人工核对（可能是别人同时在改表）。"
                : "只读复核：这次没能再读一次飞书，未做指纹对比。"}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
