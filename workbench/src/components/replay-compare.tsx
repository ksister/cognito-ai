"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCheck, FileText, Images, Loader2, Play, X } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { ChatBubbles } from "@/components/chat-bubbles"
import { buildBubbleItems, summarizeBubbles, type BubbleItem } from "@/lib/chat-bubble-view"
import { cn } from "@/lib/utils"
import { statusLabel, type ReplayStatus } from "@/lib/replay-model"
import { ME } from "@/lib/speaker-resolve"
import {
  alignTranscripts,
  countSpeakerDiffs,
  type AlignTurn,
  type AlignedRow,
} from "@/lib/transcript-align"
import {
  REPLAY_ISSUE_LABEL,
  REPLAY_ISSUE_TYPES,
  compareReplayFields,
  friendlyRunLabel,
  isLegacySpeakerRun,
  runTooltip,
  type ReplayFieldDiff,
  type ReplayFieldReview,
  type ReplayIssueType,
  type ReplayLineMark,
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

/** 气泡标记的中文名（顶部统计和「已标」用）。 */
const MARK_LABEL: Record<"speaker" | "text" | "extra" | "quote" | "unquote", string> = {
  speaker: "改发言人",
  text: "改文字",
  extra: "多余",
  quote: "是引用",
  unquote: "不是引用",
}

/** 页面视图：核对转写（截图+转写各一半）/ 核对字段（转写 1/3 + 字段 2/3）/ 全部（三列）。 */
type PageView = "transcript" | "fields" | "all"
const PAGE_VIEW_KEY = "ae-replay-page-view"
const PAGE_VIEW_LABEL: Record<PageView, string> = {
  transcript: "核对转写",
  fields: "核对字段",
  all: "全部",
}

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

type LineRow = { speaker: string; text: string; kind: "speech" | "time" }

const SPEAKER_LINE = /^([^：:]{1,40})[：:](.*)$/

/** 把格式化后的转写拆成行（[OCR 标记] 跳过；—— 时间 —— 单独一行）。 */
function parseTranscriptLines(transcript: string): LineRow[] {
  const out: LineRow[] = []
  for (const raw of String(transcript ?? "").split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("[OCR")) continue
    if (/^——.*——$/.test(line)) {
      out.push({ speaker: "", text: line, kind: "time" })
      continue
    }
    const m = line.match(SPEAKER_LINE)
    if (m) out.push({ speaker: m[1].trim(), text: m[2].trim(), kind: "speech" })
    else out.push({ speaker: "", text: line, kind: "speech" })
  }
  return out
}

/** 对齐用的行：优先用结果里存的 turns（带 side / rawSpeaker），老结果退化成解析文本。 */
function turnsOfRun(run: ReplayRun): AlignTurn[] {
  if (run.turns?.length) {
    return run.turns.map((t) => ({ speaker: t.speaker, text: t.text, kind: t.kind === "time" ? "time" : "speech", side: t.side }))
  }
  return parseTranscriptLines(run.transcript)
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
  const [onlyMe, setOnlyMe] = useState(false)
  const [compareRunId, setCompareRunId] = useState("")
  const [speakerError, setSpeakerError] = useState(() => Boolean(runs[0]?.review?.speakerError))
  const [speakerErrCount, setSpeakerErrCount] = useState(() =>
    runs[0]?.review?.speakerErrorCount ? String(runs[0].review.speakerErrorCount) : "",
  )
  const [textError, setTextError] = useState(() => Boolean(runs[0]?.review?.textError))
  const [textErrCount, setTextErrCount] = useState(() =>
    runs[0]?.review?.textErrorCount ? String(runs[0].review.textErrorCount) : "",
  )
  const [textErrNote, setTextErrNote] = useState(() => runs[0]?.review?.textErrorNote ?? "")
  const [viewMode, setViewMode] = useState<"bubble" | "text">("bubble")
  const [pageView, setPageView] = useState<PageView>(() => {
    // 记住用户上次的选择；隐私模式/禁用 localStorage 时退回默认（核对转写）。
    try {
      const saved = typeof window !== "undefined" ? window.localStorage.getItem(PAGE_VIEW_KEY) : null
      if (saved === "transcript" || saved === "fields" || saved === "all") return saved
    } catch {
      /* 读不到就用默认 */
    }
    return "transcript"
  })
  const [marks, setMarks] = useState<ReplayLineMark[]>(() => runs[0]?.review?.lineMarks ?? [])
  const [editingLine, setEditingLine] = useState<number | null>(null)
  const [editSpeaker, setEditSpeaker] = useState("我")
  const [editText, setEditText] = useState("")

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
    setSpeakerError(Boolean(fresh.review?.speakerError))
    setSpeakerErrCount(fresh.review?.speakerErrorCount ? String(fresh.review.speakerErrorCount) : "")
    setTextError(Boolean(fresh.review?.textError))
    setTextErrCount(fresh.review?.textErrorCount ? String(fresh.review.textErrorCount) : "")
    setTextErrNote(fresh.review?.textErrorNote ?? "")
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

  // 记住用户上次选的页面视图（localStorage 写失败也不影响使用）。
  useEffect(() => {
    try {
      window.localStorage.setItem(PAGE_VIEW_KEY, pageView)
    } catch {
      /* 写不进去就算了，下次还是默认 */
    }
  }, [pageView])

  const right = useMemo(() => selected?.fields ?? {}, [selected])
  const diffs = useMemo(() => compareReplayFields(left, right, keys), [left, right, keys])
  const changedRows = diffs.filter((d) => !d.same)
  const sameRows = diffs.filter((d) => d.same)
  const transcriptLines = selected ? selected.transcript.split("\n").filter(Boolean).length : 0

  const transcriptLineRows = useMemo(() => parseTranscriptLines(selected?.transcript ?? ""), [selected])
  const compareRun = useMemo(() => runs.find((r) => r.runId === compareRunId) ?? null, [runs, compareRunId])
  const compareRows: AlignedRow[] = useMemo(
    () => (selected && compareRun ? alignTranscripts(turnsOfRun(selected), turnsOfRun(compareRun)) : []),
    [selected, compareRun],
  )

  // 气泡视图（PR-B）：纯显示模型 + 顶部统计 + 待核对（引用找不到原话 / 回复拆不出引用）。
  const bubbles: BubbleItem[] = useMemo(
    () => buildBubbleItems(selected?.turns ?? [], marks),
    [selected, marks],
  )
  const bubbleStats = useMemo(() => summarizeBubbles(bubbles), [bubbles])

  function pickRun(runId: string) {
    const run = runs.find((r) => r.runId === runId) ?? null
    const nextEdits = editsFromRun(run)
    setSelectedId(runId)
    setEdits(nextEdits)
    setLastSaved(JSON.stringify(nextEdits))
    setSpeakerError(Boolean(run?.review?.speakerError))
    setSpeakerErrCount(run?.review?.speakerErrorCount ? String(run.review.speakerErrorCount) : "")
    setTextError(Boolean(run?.review?.textError))
    setTextErrCount(run?.review?.textErrorCount ? String(run.review.textErrorCount) : "")
    setTextErrNote(run?.review?.textErrorNote ?? "")
    setMarks(run?.review?.lineMarks ?? [])
    setEditingLine(null)
    setCompareRunId((cur) => (cur === runId ? "" : cur))
    setSavedAt(null)
    setError(null)
  }

  function setField(key: string, patch: Partial<ReplayFieldReview>) {
    setEdits((cur) => applyField(cur, key, patch))
  }

  /** 气泡上标的错：同一行同一类型只留最后一条，立刻保存到这次运行的核对结果。 */
  function upsertMark(mark: ReplayLineMark) {
    const next = [...marks.filter((m) => !(m.line === mark.line && m.type === mark.type)), mark].sort(
      (a, b) => a.line - b.line,
    )
    void save(false, edits, next)
  }

  function removeMark(line: number, type: ReplayLineMark["type"]) {
    const next = marks.filter((m) => !(m.line === line && m.type === type))
    void save(false, edits, next)
  }

  function scrollToPending() {
    const target = bubbleStats.pending[0]
    if (!target) return
    const el = document.getElementById(`chat-line-${target.line}`)
    el?.scrollIntoView({ behavior: "smooth", block: "center" })
    el?.classList.add("ring-2", "ring-sky-500")
  }

  async function save(reviewed: boolean, fields: Edits = edits, nextMarks: ReplayLineMark[] = marks) {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      const count = Number.parseInt(speakerErrCount, 10)
      const textCount = Number.parseInt(textErrCount, 10)
      // 气泡上有标记时自动勾上对应的「发言人有误」「文字有误」；用户也可以手动勾。
      const speakerFlag = speakerError || nextMarks.some((m) => m.type === "speaker")
      const textFlag = textError || nextMarks.some((m) => m.type === "text")
      const res = await fetch("/api/replay/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordId: record.recordId,
          runId: selected.runId,
          fields,
          reviewed,
          speakerError: speakerFlag,
          speakerErrorCount: Number.isFinite(count) && count > 0 ? count : 0,
          textError: textFlag,
          textErrorCount: Number.isFinite(textCount) && textCount > 0 ? textCount : 0,
          textErrorNote: textErrNote,
          lineMarks: nextMarks,
        }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) {
        setError(data.error ?? `保存失败（HTTP ${res.status}）`)
        return
      }
      if (speakerFlag) setSpeakerError(true)
      if (textFlag) setTextError(true)
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
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">视图</span>
        <span className="inline-flex overflow-hidden rounded-lg border">
          {(["transcript", "fields", "all"] as PageView[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setPageView(v)}
              className={cn(
                "px-2.5 py-1",
                pageView === v ? "bg-foreground text-background" : "bg-background hover:bg-muted",
              )}
            >
              {PAGE_VIEW_LABEL[v]}
            </button>
          ))}
        </span>
        <span className="text-muted-foreground">
          {pageView === "transcript"
            ? "截图和转写各占一半，字段对比收起"
            : pageView === "fields"
              ? "转写 1/3、字段对比 2/3，截图收起"
              : "三列都在：截图 | 转写 | 字段对比"}
        </span>
      </div>
      {/* 宽屏（≥1400px）三列：截图 1/4 | 转写 1/4 | 字段对比 1/2；不够宽时退回「截图 / 转写」切换 */}
      <div className={cn("replay-grid", `replay-grid--${pageView}`)}>
        {/* 截图列：滚动固定、单独滚动；不确定项放在这一列下面；「核对字段」视图里收起 */}
        <div
          className={cn(
            "replay-side space-y-2",
            pane === "transcript" && "replay-hide-narrow",
            pageView === "fields" && "replay-hide-view",
          )}
        >
          <Card className="py-0">
            <div className="replay-toggle flex items-center gap-1 border-b px-2 py-1.5">
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
              {shots.length ? (
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
              )}
            </div>
          </Card>

          {(selected?.warning || (selected?.uncertain?.length ?? 0) > 0) && (
            <Card className="py-0">
              <div className="space-y-1 px-3 py-2 text-[11px]">
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
            </Card>
          )}
        </div>

        {/* 转写列：宽屏独立一列、单独滚动；窄屏和截图列二选一（「核对字段」视图里截图收起，转写照常显示） */}
        <div
          className={cn(
            "replay-side space-y-2",
            pane === "shots" && pageView !== "fields" && "replay-hide-narrow",
          )}
        >
          <Card className="py-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-xs">
              <span className="inline-flex items-center gap-1 font-medium">
                <FileText className="size-3.5" />
                转写{selected ? ` · ${transcriptLines} 行` : ""}
                {compareRows.length > 0 && (
                  <span className="ml-1 text-amber-700">· 发言人不同 {countSpeakerDiffs(compareRows)} 行</span>
                )}
              </span>
              <span className="text-muted-foreground replay-toggle">
                {pageView !== "fields" && (
                  <button type="button" onClick={() => setPane("shots")} className="hover:text-foreground">
                    返回截图
                  </button>
                )}
              </span>
            </div>

            <div className="space-y-1.5 border-b px-2 py-2 text-[11px]">
              {selected && isLegacySpeakerRun(selected) && (
                <p className="rounded bg-amber-50 px-2 py-1 text-amber-800">
                  这次结果是「旧规则」跑的，发言人可能不准；核对请选历史里没有「旧规则」标记的那几次。
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={onlyMe}
                    onChange={(e) => setOnlyMe(e.target.checked)}
                    className="size-3.5"
                  />
                  只看「我」
                </label>
                <label className="inline-flex items-center gap-1.5 text-muted-foreground">
                  对比另一次运行
                  <select
                    value={compareRunId}
                    onChange={(e) => setCompareRunId(e.target.value)}
                    className="h-7 max-w-[12rem] rounded-md border bg-background px-1.5 text-[11px] text-foreground"
                  >
                    <option value="">不对比</option>
                    {runs
                      .filter((r) => r.runId !== selected?.runId)
                      .map((run, i) => (
                        <option key={run.runId} value={run.runId}>
                          {friendlyRunLabel(run, runs.length - i)}
                          {isLegacySpeakerRun(run) ? " · 旧规则" : ""}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              {compareRunId && compareRows.length > 0 && (
                <p className="text-muted-foreground">黄色 = 同一句话、两版发言人不同；灰色 = 另一版没有这一行。</p>
              )}
              <div className="flex flex-wrap items-center gap-2 border-t pt-1.5">
                <span className="inline-flex overflow-hidden rounded border text-[11px]">
                  <button
                    type="button"
                    onClick={() => setViewMode("bubble")}
                    className={cn("px-2 py-0.5", viewMode === "bubble" ? "bg-foreground text-background" : "bg-background")}
                  >
                    气泡
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("text")}
                    className={cn("px-2 py-0.5", viewMode === "text" ? "bg-foreground text-background" : "bg-background")}
                  >
                    纯文本
                  </button>
                </span>
                <span className="text-muted-foreground">
                  发言人改了 {bubbleStats.speakerChanged} · 文字改了 {bubbleStats.textChanged} · 引用{" "}
                  {bubbleStats.quoteMarked} · 不是引用 {bubbleStats.unquoteMarked} · 多余 {bubbleStats.extraMarked}
                </span>
                {bubbleStats.staleMarks > 0 && (
                  <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-700">
                    有 {bubbleStats.staleMarks} 处标记对不上当前转写，请重新核对
                  </span>
                )}
                <button
                  type="button"
                  onClick={scrollToPending}
                  disabled={!bubbleStats.pending.length}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[11px]",
                    bubbleStats.pending.length
                      ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                      : "text-muted-foreground",
                  )}
                >
                  待核对 {bubbleStats.pending.length} 处
                  {bubbleStats.pending.length ? "（点一下跳过去）" : ""}
                </button>
              </div>
            </div>

            <div className="p-2">
              {selected ? (
                <div className="max-h-[calc(100vh-10rem)] overflow-auto rounded-lg bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                  {compareRunId ? (
                    compareRows.map((row, i) => (
                      <div
                        key={i}
                        className={cn(
                          "flex gap-1 rounded px-1",
                          row.speakerDiff && "bg-amber-100",
                          !row.speakerDiff && !row.right && "text-muted-foreground",
                          onlyMe && row.left && row.left.speaker !== ME && "opacity-40",
                        )}
                      >
                        <span className="shrink-0">
                          {row.left ? (
                            row.left.kind === "time" ? null : (
                              <span className="font-semibold">{row.left.speaker || "未知"}：</span>
                            )
                          ) : (
                            <span className="text-zinc-400">（另一版多一行）</span>
                          )}
                        </span>
                        <span className="min-w-0 break-words whitespace-pre-wrap">
                          {row.left?.text ?? ""}
                          {row.speakerDiff && row.right && (
                            <span className="ml-1 rounded bg-amber-200 px-1 text-[10px] text-amber-900">
                              另一版：{row.right.speaker || "未知"}
                            </span>
                          )}
                          {row.nameVariant && row.right && (
                            <span
                              className="ml-1 text-[10px] text-muted-foreground"
                              title={`另一版写成：${row.right.speaker}`}
                            >
                              名字写法不同
                            </span>
                          )}
                          {!row.right && <span className="ml-1 rounded bg-zinc-200 px-1 text-[10px]">另一版没有</span>}
                        </span>
                      </div>
                    ))
                  ) : viewMode === "bubble" ? (
                    <ChatBubbles
                      items={bubbles}
                      dimOthers={onlyMe}
                      isSpeakerDiff={(item) => compareRows.some((r) => r.left?.text === item.text && r.speakerDiff)}
                      onBubbleClick={(item) => {
                        setEditingLine((cur) => (cur === item.line ? null : item.line))
                        setEditSpeaker(item.speaker)
                        setEditText(item.displayText)
                      }}
                      onQuoteClick={(item) => {
                        setEditingLine(item.line)
                        setEditSpeaker(item.speaker)
                        setEditText(item.displayText)
                      }}
                      renderActions={(item) =>
                        editingLine === item.line ? (
                          <div className="mt-1 w-full max-w-[18rem] space-y-1 rounded-lg border bg-background p-2 text-[11px] shadow-sm">
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="text-muted-foreground">发言人：</span>
                              {(["我", "客户", "我方同事", "系统"] as const).map((v) => (
                                <button
                                  key={v}
                                  type="button"
                                  onClick={() =>
                                    upsertMark({
                                      line: item.line,
                                      type: "speaker",
                                      originalSpeaker: item.originalSpeaker,
                                      originalText: item.originalText,
                                      newSpeaker: v,
                                    })
                                  }
                                  className={cn(
                                    "rounded border px-1.5 py-0.5",
                                    editSpeaker === v ? "bg-foreground text-background" : "hover:bg-muted",
                                  )}
                                >
                                  {v}
                                </button>
                              ))}
                            </div>
                            <div className="flex items-start gap-1">
                              <span className="pt-1 text-muted-foreground">文字：</span>
                              <Textarea
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                rows={2}
                                className="min-h-8 bg-background text-[11px]"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  upsertMark({
                                    line: item.line,
                                    type: "text",
                                    originalSpeaker: item.originalSpeaker,
                                    originalText: item.originalText,
                                    newText: editText,
                                  })
                                }
                                className="mt-1 shrink-0 rounded border px-1.5 py-0.5 hover:bg-muted"
                              >
                                保存文字
                              </button>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              <button
                                type="button"
                                onClick={() =>
                                  upsertMark({
                                    line: item.line,
                                    type: "extra",
                                    originalSpeaker: item.originalSpeaker,
                                    originalText: item.originalText,
                                  })
                                }
                                className="rounded border border-red-200 px-1.5 py-0.5 text-red-700 hover:bg-red-50"
                              >
                                多余（这行不该存在）
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  upsertMark({
                                    line: item.line,
                                    type: "quote",
                                    originalSpeaker: item.originalSpeaker,
                                    originalText: item.originalText,
                                  })
                                }
                                className="rounded border px-1.5 py-0.5 hover:bg-muted"
                              >
                                是引用（并进上一条）
                              </button>
                              {(item.quote || item.replyUnsplit) && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    upsertMark({
                                      line: item.line,
                                      type: "unquote",
                                      originalSpeaker: item.originalSpeaker,
                                      originalText: item.originalText,
                                    })
                                  }
                                  className="rounded border border-amber-300 px-1.5 py-0.5 text-amber-800 hover:bg-amber-50"
                                >
                                  不是引用（拆回单独一条）
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => setEditingLine(null)}
                                className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                              >
                                收起
                              </button>
                            </div>
                            {item.markedTypes.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
                                已标：
                                {item.markedTypes.map((t) => (
                                  <button
                                    key={t}
                                    type="button"
                                    onClick={() => removeMark(item.line, t)}
                                    className="rounded bg-muted px-1 hover:bg-muted-foreground/20"
                                  >
                                    {MARK_LABEL[t]} ×
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : null
                      }
                    />
                  ) : (
                    transcriptLineRows.map((line, i) => (
                      <div
                        key={i}
                        className={cn(
                          "rounded px-1 whitespace-pre-wrap break-words",
                          onlyMe && line.speaker !== ME && "opacity-40",
                        )}
                      >
                        {line.kind === "time" ? (
                          line.text
                        ) : (
                          <>
                            <span className="font-semibold">{line.speaker || "未知"}：</span>
                            {line.text}
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">跑过一次之后，这里显示这次用的转写。</p>
              )}
            </div>
          </Card>
        </div>

        {/* 字段对比：宽屏占一半；「核对转写」视图里收起 */}
        <div className={cn("space-y-3", pageView === "transcript" && "replay-hide-view")}>
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
                          {isLegacySpeakerRun(run) ? " · 旧规则" : ""}
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

              {/* 记录级核对：发言人（谁说的）对不对 */}
              <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-2.5 py-1.5 text-xs">
                <label className="inline-flex items-center gap-1.5 font-medium">
                  <input
                    type="checkbox"
                    checked={speakerError}
                    onChange={(e) => {
                      setSpeakerError(e.target.checked)
                      const count = Number.parseInt(speakerErrCount, 10)
                      const nextFields = edits
                      setEdits(nextFields)
                      void fetch("/api/replay/review", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          recordId: record.recordId,
                          runId: selected?.runId,
                          fields: nextFields,
                          reviewed: false,
                          speakerError: e.target.checked,
                          speakerErrorCount: Number.isFinite(count) && count > 0 ? count : 0,
                        }),
                      })
                    }}
                    className="size-3.5"
                  />
                  发言人有误
                </label>
                <label className="inline-flex items-center gap-1 text-muted-foreground">
                  错了几条
                  <input
                    type="number"
                    min={0}
                    max={9999}
                    value={speakerErrCount}
                    onChange={(e) => setSpeakerErrCount(e.target.value)}
                    onBlur={() => void save(false)}
                    placeholder="0"
                    className="h-6 w-16 rounded-md border bg-background px-1.5 text-right text-xs"
                  />
                </label>
                {speakerError && (
                  <span className="text-amber-700">
                    这条记录会算「有问题」
                    {Number.parseInt(speakerErrCount, 10) > 0 ? `，错 ${Number.parseInt(speakerErrCount, 10)} 条` : ""}
                  </span>
                )}
                <span className="text-muted-foreground">勾上并填条数后点「完成核对」保存</span>
              </div>

              {/* 记录级核对：文字（转写内容）对不对 */}
              <div className="space-y-1.5 rounded-lg border bg-muted/30 px-2.5 py-1.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 font-medium">
                    <input
                      type="checkbox"
                      checked={textError}
                      onChange={(e) => {
                        setTextError(e.target.checked)
                        const count = Number.parseInt(textErrCount, 10)
                        void fetch("/api/replay/review", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            recordId: record.recordId,
                            runId: selected?.runId,
                            fields: edits,
                            reviewed: false,
                            speakerError,
                            speakerErrorCount: Number.isFinite(Number.parseInt(speakerErrCount, 10))
                              ? Math.max(0, Number.parseInt(speakerErrCount, 10))
                              : 0,
                            textError: e.target.checked,
                            textErrorCount: Number.isFinite(count) && count > 0 ? count : 0,
                            textErrorNote: textErrNote,
                          }),
                        })
                      }}
                      className="size-3.5"
                    />
                    文字有误
                  </label>
                  <label className="inline-flex items-center gap-1 text-muted-foreground">
                    错了几处
                    <input
                      type="number"
                      min={0}
                      max={9999}
                      value={textErrCount}
                      onChange={(e) => setTextErrCount(e.target.value)}
                      onBlur={() => void save(false)}
                      placeholder="0"
                      className="h-6 w-16 rounded-md border bg-background px-1.5 text-right text-xs"
                    />
                  </label>
                  {textError && (
                    <span className="text-amber-700">
                      这条记录会算「有问题」
                      {Number.parseInt(textErrCount, 10) > 0 ? `，错 ${Number.parseInt(textErrCount, 10)} 处` : ""}
                    </span>
                  )}
                </div>
                <Textarea
                  value={textErrNote}
                  onChange={(e) => setTextErrNote(e.target.value)}
                  onBlur={() => void save(false)}
                  placeholder="备注（可留空）：原文和转写的对照，例如「闪退有哪天」被转成「闪退有哪」，漏了一个字"
                  rows={2}
                  className="min-h-9 bg-background text-xs"
                  aria-label="文字错误备注"
                />
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
