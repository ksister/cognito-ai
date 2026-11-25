"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCheck, FileText, Images, Loader2, Play, X } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { statusLabel, type ReplayStatus } from "@/lib/replay-model"
import {
  REPLAY_ISSUE_LABEL,
  REPLAY_ISSUE_TYPES,
  compareReplayFields,
  friendlyRunLabel,
  runTooltip,
  type ReplayFieldDiff,
  type ReplayFieldReview,
  type ReplayIssueType,
  type ReplayRun,
  type ReplayRunState,
} from "@/lib/replay-result"

type RecordInfo = {
  r: string
  recordId: string
  title: string
  date: string
  customer: string
  screenshotCount: number
  /** 快照里有全部字段（老快照刷新一次才会补齐）。 */
  fieldsComplete: boolean
}

export type ReplayCompareShot = {
  index: number
  url: string
  isChat: boolean
  category: string
}

type ReorganizePreviewData = {
  mode: "reorganize"
  model: string
  promptVersion: string
  aiConfigured: boolean
  shots: number
  missingTranscripts: number
  transcriptChars: number
  transcriptLines: number
  truncated: boolean
  previousRuns: number
  estimate: { promptTokens: number; completionTokens: number; costYuan: number | null; priceNote: string }
}

type RetranscribePreviewData = {
  mode: "retranscribe"
  vlModel: string
  model: string
  promptVersion: string
  transcriptPromptVersion: string
  shots: number
  skipped: number
  missingMedia: number
  myNicknameCount: number
  companyPrefixCount: number
  previousRuns: number
  estimate: {
    vlPromptTokens: number
    vlCompletionTokens: number
    fieldPromptTokens: number
    fieldCompletionTokens: number
    costYuan: number | null
    missingPrice: string[]
    priceNote: string
  }
}

type PreviewData = ReorganizePreviewData | RetranscribePreviewData

type Preview = { ok?: boolean; error?: string; preview?: PreviewData }

type RunMode = "reorganize" | "retranscribe"
type Edits = Record<string, ReplayFieldReview>

const STATUS_STYLE: Record<ReplayStatus, string> = {
  untested: "bg-zinc-100 text-zinc-600 border-zinc-200",
  tested: "bg-emerald-50 text-emerald-700 border-emerald-200",
  issue: "bg-amber-50 text-amber-700 border-amber-200",
}

/** 把一次修改合进编辑状态；建议和问题类型都空的字段直接删掉。 */
function applyField(edits: Edits, key: string, patch: Partial<ReplayFieldReview>): Edits {
  const next = { ...edits }
  const current = next[key] ?? { note: "", issue: null }
  next[key] = { note: patch.note ?? current.note, issue: patch.issue === undefined ? current.issue : patch.issue }
  if (!next[key].note.trim() && !next[key].issue) delete next[key]
  return next
}

function sameEdits(a: Edits, b: Edits): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function editsFromRun(run: ReplayRun | null): Edits {
  const out: Edits = {}
  for (const [key, value] of Object.entries(run?.review?.fields ?? {})) out[key] = { ...value }
  return out
}

function timeText(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ReplayCompare({
  record,
  keys,
  left,
  runs,
  state,
  shots,
}: {
  record: RecordInfo
  keys: string[]
  left: Record<string, string>
  runs: ReplayRun[]
  state: ReplayRunState
  shots: ReplayCompareShot[]
}) {
  const router = useRouter()
  const [selectedId, setSelectedId] = useState<string | null>(runs[0]?.runId ?? null)
  const selected = runs.find((r) => r.runId === selectedId) ?? runs[0] ?? null
  const [edits, setEdits] = useState<Edits>(() => editsFromRun(runs[0] ?? null))
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [lastSaved, setLastSaved] = useState<string>(() => JSON.stringify(editsFromRun(runs[0] ?? null)))
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [loadingPreview, setLoadingPreview] = useState<RunMode | null>(null)
  const [showSame, setShowSame] = useState(false)
  const [pane, setPane] = useState<"shots" | "transcript">(shots.length ? "shots" : "transcript")
  const [zoom, setZoom] = useState<ReplayCompareShot | null>(null)

  // 刷新页面后如果多了新结果（刚跑完），自动切到最新那次。
  const knownRuns = useRef<Set<string>>(new Set(runs.map((r) => r.runId)))
  useEffect(() => {
    const added = runs.filter((r) => !knownRuns.current.has(r.runId))
    knownRuns.current = new Set(runs.map((r) => r.runId))
    if (!added.length) return
    const fresh = added[0]
    setSelectedId(fresh.runId)
    setEdits(editsFromRun(fresh))
    setLastSaved(JSON.stringify(editsFromRun(fresh)))
    setSavedAt(null)
  }, [runs])

  // 放大时按 Esc 关闭。
  useEffect(() => {
    if (!zoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoom(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [zoom])

  const right = useMemo(() => selected?.fields ?? {}, [selected])
  const diffs = useMemo(() => compareReplayFields(left, right, keys), [left, right, keys])
  const changedRows = diffs.filter((d) => !d.same)
  const sameRows = diffs.filter((d) => d.same)
  const transcriptLines = selected ? selected.transcript.split("\n").filter(Boolean).length : 0

  function pickRun(runId: string) {
    const run = runs.find((r) => r.runId === runId) ?? null
    const nextEdits = editsFromRun(run)
    setSelectedId(runId)
    setEdits(nextEdits)
    setLastSaved(JSON.stringify(nextEdits))
    setSavedAt(null)
    setError(null)
  }

  function setField(key: string, patch: Partial<ReplayFieldReview>) {
    setEdits((cur) => applyField(cur, key, patch))
  }

  async function save(reviewed: boolean, fields: Edits = edits) {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/replay/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: record.recordId, runId: selected.runId, fields, reviewed }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) {
        setError(data.error ?? `保存失败（HTTP ${res.status}）`)
        return
      }
      setSavedAt(new Date().toISOString())
      setLastSaved(JSON.stringify(fields))
      if (reviewed) {
        toast.success("已记为核对完成")
        router.refresh()
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  /** 选完问题类型立刻存（这时 state 还没更新，所以把算好的结果传进去）。 */
  function setFieldNow(key: string, patch: Partial<ReplayFieldReview>) {
    const next = applyField(edits, key, patch)
    setEdits(next)
    void save(false, next)
  }

  /** 失焦时把建议存下来（不点「完成核对」也留得住）。 */
  function saveOnBlur() {
    if (!selected) return
    if (sameEdits(edits, editsFromRun(selected))) return
    if (JSON.stringify(edits) === lastSaved) return
    void save(false)
  }

  async function openPreview(mode: RunMode) {
    setLoadingPreview(mode)
    setError(null)
    try {
      const res = await fetch(`/api/replay/run?r=${encodeURIComponent(record.r)}&mode=${mode}`)
      const data = (await res.json()) as Preview
      if (!res.ok || !data.ok || !data.preview) {
        setError(data.error ?? `预览失败（HTTP ${res.status}）`)
        return
      }
      setPreview(data.preview)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoadingPreview(null)
    }
  }

  async function runNow(mode: RunMode) {
    setRunning(true)
    setError(null)
    try {
      const res = await fetch("/api/replay/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ r: record.r, mode, confirm: true }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string; run?: { durationMs: number; costYuan: number | null } }
      if (!res.ok || !data.ok || !data.run) {
        setError(data.error ?? `运行失败（HTTP ${res.status}）`)
        return
      }
      const cost = data.run.costYuan == null ? "" : `，约 ${data.run.costYuan.toFixed(3)} 元`
      toast.success(`跑完了：${(data.run.durationMs / 1000).toFixed(1)} 秒${cost}`)
      setPreview(null)
      setPane("transcript")
      router.refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const reviewedAt = selected?.review?.reviewedAt ?? null
  const savingHint = saving ? "正在保存…" : savedAt ? `建议已保存（${timeText(savedAt)}）` : null

  return (
    <>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:items-start">
        {/* 左栏：截图 / 转写。窗口够宽时滚动固定，不够宽时自动排到上方。 */}
        <aside className="space-y-2 lg:sticky lg:top-3">
          <Card className="py-0">
            <div className="flex items-center gap-1 border-b px-2 py-1.5">
              <button
                type="button"
                onClick={() => setPane("shots")}
                aria-pressed={pane === "shots"}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium",
                  pane === "shots" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
                )}
              >
                <Images className="size-3.5" />
                截图 {shots.length}
              </button>
              <button
                type="button"
                onClick={() => setPane("transcript")}
                aria-pressed={pane === "transcript"}
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium",
                  pane === "transcript" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
                )}
              >
                <FileText className="size-3.5" />
                转写{selected ? ` ${transcriptLines} 行` : ""}
              </button>
            </div>

            <div className="p-2">
              {pane === "shots" ? (
                shots.length ? (
                  <div className="space-y-2">
                    {shots.map((shot) => (
                      <button
                        key={shot.index}
                        type="button"
                        onClick={() => setZoom(shot)}
                        title="点击放大"
                        className="block w-full overflow-hidden rounded-lg border bg-muted/20 text-left hover:border-primary/40"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={shot.url} alt={`第 ${shot.index + 1} 张截图`} className="w-full" />
                        <span className="flex items-center justify-between px-2 py-1 text-[11px] text-muted-foreground">
                          <span>第 {shot.index + 1} 张</span>
                          {!shot.isChat && <span>{shot.category || "非聊天截图"}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">这条记录没有截图。</p>
                )
              ) : selected ? (
                <pre className="max-h-[70vh] overflow-auto rounded-lg bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                  {selected.transcript}
                </pre>
              ) : (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">跑过一次之后，这里显示这次用的转写。</p>
              )}
            </div>

            {(selected?.warning || (selected?.uncertain?.length ?? 0) > 0) && (
              <div className="space-y-1 border-t px-2 py-2 text-[11px]">
                {selected?.warning && <p className="text-amber-700">{selected.warning}</p>}
                {selected && selected.uncertain.length > 0 && (
                  <div className="text-muted-foreground">
                    不确定项：
                    <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                      {selected.uncertain.map((u, i) => (
                        <li key={i}>{u}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </Card>
        </aside>

        {/* 右栏：字段对比 */}
        <div className="space-y-3">
          <Card className="py-3">
            <CardContent className="space-y-3 px-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">{record.customer || "（无客户）"}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">{record.date || "（无日期）"}</span>
                <Badge variant="outline" className={STATUS_STYLE[state.status]}>
                  {statusLabel(state.status)}
                </Badge>
                {state.pendingReview && (
                  <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                    有新结果待核对
                  </Badge>
                )}
                {selected && (
                  <span className="text-xs text-muted-foreground">
                    {selected.durationMs ? `${(selected.durationMs / 1000).toFixed(1)} 秒` : ""}
                    {selected.costYuan != null ? ` · 约 ${selected.costYuan.toFixed(3)} 元` : ""}
                    {selected.extractMode === "rules" ? " · 规则提取（没配 AI key）" : ""}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {runs.length > 0 ? (
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    历史
                    <select
                      value={selected?.runId ?? ""}
                      onChange={(e) => pickRun(e.target.value)}
                      title={selected ? runTooltip(selected) : undefined}
                      className="h-8 max-w-[20rem] rounded-lg border bg-background px-2 text-xs text-foreground"
                    >
                      {runs.map((run, i) => (
                        <option key={run.runId} value={run.runId} title={runTooltip(run)}>
                          {friendlyRunLabel(run, runs.length - i)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span className="text-xs text-muted-foreground">还没有跑过：先点「只重跑整理」，会先显示预计费用。</span>
                )}

                <button
                  type="button"
                  onClick={() => void openPreview("reorganize")}
                  disabled={loadingPreview !== null || running}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
                >
                  {loadingPreview === "reorganize" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                  只重跑整理
                </button>
                <button
                  type="button"
                  onClick={() => void openPreview("retranscribe")}
                  disabled={loadingPreview !== null || running || record.screenshotCount === 0}
                  title={record.screenshotCount === 0 ? "这条记录没有截图" : "用快照里的截图重新转写，再出字段"}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
                >
                  {loadingPreview === "retranscribe" ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Images className="size-3.5" />
                  )}
                  重新看图转写
                </button>
                <button
                  type="button"
                  onClick={() => void save(true)}
                  disabled={!selected || saving || running}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-60"
                >
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCheck className="size-3.5" />}
                  完成核对
                </button>
                {reviewedAt && <span className="text-xs text-muted-foreground">已核对 {timeText(reviewedAt)}</span>}
                {savingHint && <span className="text-xs text-muted-foreground">{savingHint}</span>}
              </div>

              {!record.fieldsComplete && (
                <p className="text-xs text-amber-700">
                  这条快照是旧格式，左边只显示部分字段；到「回放测试」页刷新一次快照（增量、不重新转写）就能补齐全部列。
                </p>
              )}
              {error && (
                <p className="flex items-start gap-1.5 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  {error}
                </p>
              )}
            </CardContent>
          </Card>

          {preview && (
            <Card className="border-primary/30">
              <CardHeader>
                <CardTitle className="text-sm">这次要花多少（还没调模型）</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <ul className="space-y-1 text-muted-foreground">
                  {preview.mode === "reorganize" ? (
                    <>
                      <li>
                        {record.r} · 用快照已有转写：{preview.transcriptChars} 字 / {preview.transcriptLines} 行，截图 {preview.shots} 张
                        {preview.missingTranscripts ? `（${preview.missingTranscripts} 张没有可用转写）` : ""}
                      </li>
                      <li>
                        模型 {preview.model} · 提示词 {preview.promptVersion} · 这条记录已有 {preview.previousRuns} 次结果
                      </li>
                      <li>
                        预计 {preview.estimate.promptTokens} 输入 / {preview.estimate.completionTokens} 输出 tokens
                      </li>
                      <li>
                        预计费用：
                        {preview.estimate.costYuan == null
                          ? `无法估算（${preview.estimate.priceNote}）`
                          : `约 ${preview.estimate.costYuan.toFixed(3)} 元（${preview.estimate.priceNote}）`}
                      </li>
                      {preview.truncated && <li className="text-amber-700">转写超过 3 万字，只送前 3 万字给模型。</li>}
                      {!preview.aiConfigured && <li className="text-amber-700">没配 AI key，会退回规则提取（结果会很粗）。</li>}
                    </>
                  ) : (
                    <>
                      <li>
                        {record.r} · 重新转写 {preview.shots} 张聊天截图（另有 {preview.skipped} 张非聊天截图不重转）
                        {preview.missingMedia ? `（${preview.missingMedia} 张在快照里找不到图片文件）` : ""}
                      </li>
                      <li>
                        转写模型 {preview.vlModel || "（未配置）"} · 提示词 {preview.transcriptPromptVersion}；字段模型 {preview.model} · 提示词{" "}
                        {preview.promptVersion}
                      </li>
                      <li>
                        发言人配置：我的昵称 {preview.myNicknameCount} 个 · 公司前缀 {preview.companyPrefixCount} 个
                        {preview.myNicknameCount === 0 ? "（还没填，只看气泡左右）" : ""}
                      </li>
                      <li>
                        预计 tokens：转写 {preview.estimate.vlPromptTokens} 输入 / {preview.estimate.vlCompletionTokens} 输出，字段{" "}
                        {preview.estimate.fieldPromptTokens} 输入 / {preview.estimate.fieldCompletionTokens} 输出
                      </li>
                      <li>
                        预计费用：
                        {preview.estimate.costYuan == null
                          ? `无法估算（缺单价：${preview.estimate.missingPrice.join("、")}）`
                          : `约 ${preview.estimate.costYuan.toFixed(3)} 元（${preview.estimate.priceNote}）`}
                      </li>
                      <li>这条记录已有 {preview.previousRuns} 次结果。</li>
                      {preview.missingMedia > 0 && (
                        <li className="text-amber-700">有截图在快照里找不到图片文件，那几张会失败；先刷新快照再跑。</li>
                      )}
                    </>
                  )}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void runNow(preview.mode)}
                    disabled={running}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-60"
                  >
                    {running && <Loader2 className="size-3.5 animate-spin" />}
                    确认执行
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreview(null)}
                    disabled={running}
                    className="h-8 rounded-lg border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-60"
                  >
                    取消
                  </button>
                  <span className="self-center text-xs text-muted-foreground">只读快照；结果写进本地历史，不写飞书。</span>
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="py-0">
            <CardContent className="px-0">
              <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">字段对比</span>
                <span>
                  {changedRows.length} 个不同 · {sameRows.length} 个相同
                </span>
                {!selected && <span>（右边还没有结果）</span>}
              </div>

              {changedRows.length === 0 && sameRows.length === 0 && (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">表结构里没有可比对的字段，检查私有配置。</p>
              )}

              <ul className="divide-y">
                {changedRows.map((row) => (
                  <FieldRow
                    key={row.key}
                    row={row}
                    review={edits[row.key]}
                    onChange={setField}
                    onChangeNow={setFieldNow}
                    onBlur={saveOnBlur}
                    empty={!selected}
                  />
                ))}
              </ul>

              {sameRows.length > 0 && (
                <div className="border-t">
                  <button
                    type="button"
                    onClick={() => setShowSame((v) => !v)}
                    className="w-full px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted/40"
                  >
                    {showSame ? "收起" : "展开"} {sameRows.length} 个相同字段（默认折叠；也可以写建议）
                  </button>
                  {showSame && (
                    <ul className="divide-y border-t bg-muted/20">
                      {sameRows.map((row) => (
                        <FieldRow
                          key={row.key}
                          row={row}
                          review={edits[row.key]}
                          onChange={setField}
                          onChangeNow={setFieldNow}
                          onBlur={saveOnBlur}
                          empty={!selected}
                          compact
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {zoom && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`第 ${zoom.index + 1} 张截图`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setZoom(null)}
        >
          <button
            type="button"
            onClick={() => setZoom(null)}
            aria-label="关闭"
            className="absolute top-3 right-3 rounded-lg bg-background/90 p-2 text-foreground hover:bg-background"
          >
            <X className="size-4" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoom.url}
            alt={`第 ${zoom.index + 1} 张截图`}
            className="max-h-full max-w-full rounded-lg bg-background object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  )
}

function FieldRow({
  row,
  review,
  onChange,
  onChangeNow,
  onBlur,
  empty,
  compact = false,
}: {
  row: ReplayFieldDiff
  review: ReplayFieldReview | undefined
  onChange: (key: string, patch: Partial<ReplayFieldReview>) => void
  onChangeNow: (key: string, patch: Partial<ReplayFieldReview>) => void
  onBlur: () => void
  empty?: boolean
  compact?: boolean
}) {
  const issue = review?.issue ?? ""
  return (
    <li className={compact ? "px-4 py-3" : "px-4 py-4"}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{row.label}</span>
        {row.same ? (
          <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-zinc-500">
            相同
          </Badge>
        ) : (
          <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
            不同
          </Badge>
        )}
        {review?.issue && (
          <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
            {REPLAY_ISSUE_LABEL[review.issue]}
          </Badge>
        )}
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-0.5 text-[11px] text-muted-foreground">飞书原记录</p>
          <div className="max-h-40 overflow-auto rounded-lg border bg-muted/30 px-2.5 py-2 text-sm whitespace-pre-wrap">
            {row.left?.trim() ? row.left : <span className="text-muted-foreground">（空）</span>}
          </div>
        </div>
        <div className="min-w-0">
          <p className="mb-0.5 text-[11px] text-muted-foreground">本次结果</p>
          <div
            className={
              row.same
                ? "max-h-40 overflow-auto rounded-lg border bg-muted/20 px-2.5 py-2 text-sm whitespace-pre-wrap"
                : "max-h-40 overflow-auto rounded-lg border border-primary/25 bg-primary/5 px-2.5 py-2 text-sm whitespace-pre-wrap"
            }
          >
            {empty ? (
              <span className="text-muted-foreground">（还没有结果）</span>
            ) : row.right?.trim() ? (
              row.right
            ) : (
              <span className="text-muted-foreground">（空）</span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
        <Textarea
          value={review?.note ?? ""}
          onChange={(e) => onChange(row.key, { note: e.target.value })}
          onBlur={onBlur}
          placeholder="建议（可以留空）：这里应该怎么写"
          rows={2}
          aria-label={`${row.label} 的建议`}
          className="min-h-9 flex-1 bg-background text-sm"
        />
        <select
          value={issue}
          onChange={(e) => {
            const value = e.target.value
            onChangeNow(row.key, { issue: (value || null) as ReplayIssueType | null })
          }}
          aria-label={`${row.label} 的问题类型`}
          className="h-9 shrink-0 rounded-lg border bg-background px-2 text-sm"
        >
          <option value="">问题类型（可不选）</option>
          {REPLAY_ISSUE_TYPES.map((t) => (
            <option key={t} value={t}>
              {REPLAY_ISSUE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
    </li>
  )
}
