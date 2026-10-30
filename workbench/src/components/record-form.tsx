"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ImagePlus,
  Loader2,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { recordHref, selectClass } from "@/components/bits"
import { compressImageFile } from "@/lib/client-image"
import { CopyFallback } from "@/components/copy-fallback"
import { CopyTextError, copyText } from "@/lib/copy-text"
import { feishuClipboard } from "@/lib/feishu"
import {
  checkResolutionStatus,
  mergeExtractedDraft,
  readMulti,
  readRecordField,
  schemaColumnKeys,
  writeRecordField,
  type FeishuColumn,
  type FeishuSchemaState,
} from "@/lib/feishu-schema"
import {
  NEED_TYPES,
  emptyDraft,
  type ExtractErrorCode,
  type ExtractResult,
  type FeishuPushResult,
  type Need,
  type RecordDraft,
  type SupportRecord,
} from "@/lib/types"
import { OCR_TRANSCRIPT_MARKER, resolveExtractedChat } from "@/lib/transcript"

const MAX_SHOTS = 9

const SAMPLE_CHAT = `张工-宁德某电池厂 2026-10-28 09:12
早上好，极耳定位那个工位又开始偏了，昨天下午还好好的
小李 2026-10-28 09:15
早，偏多少？有截图吗？最近有没有动过相机或者换过料
张工-宁德某电池厂 2026-10-28 09:18
[图片]
大概偏 0.3mm，夜班换了一批新料，颜色稍微深一点
小李 2026-10-28 09:21
看图是新料反光变弱了，模板匹配分数掉到 0.62，低于你们设的 0.7 阈值，所以有些帧取的是上一次结果
小李 2026-10-28 09:22
先把曝光从 3000 调到 4500 试一下，然后在定位工具里重新学一下模板
张工-宁德某电池厂 2026-10-28 09:40
调了曝光，分数到 0.85 了，现在正常了
张工-宁德某电池厂 2026-10-28 09:41
不过每次换料都要你们远程调一次，太麻烦了，能不能软件自己适应一下，或者给我们一个简单的按钮让操作工自己重新学模板
小李 2026-10-28 09:45
好的，这个需求我记下来反馈给研发。另外建议匹配分数低于阈值时让软件报警，而不是沿用上一次结果`

type Shot = { id: string; file: File; url: string }

type Props = {
  customers: string[]
  aiLabel: string
  vlLabel?: string
  initial?: SupportRecord
  defaultCustomer?: string
  schemaState: FeishuSchemaState
  siteSuggestions?: string[]
}

const LOCAL_FIELDS: { key: "title" | "date" | "contact" | "channel" | "product" | "module" | "category" | "status" | "problem" | "process" | "solution"; label: string; multiline?: boolean; date?: boolean }[] = [
  { key: "title", label: "标题" },
  { key: "date", label: "日期", date: true },
  { key: "contact", label: "联系人" },
  { key: "channel", label: "渠道（仅本地，不导出）" },
  { key: "product", label: "产品/版本" },
  { key: "module", label: "模块（仅本地，不导出）" },
  { key: "status", label: "状态" },
  { key: "problem", label: "问题描述", multiline: true },
  { key: "process", label: "处理过程", multiline: true },
  { key: "solution", label: "解决方案 / 当前结论", multiline: true },
]

const THOUGHT_PROMPTS = ["根因判断：", "客户真正想要的是：", "软件可以改进：", "下次遇到可以直接：", "需要补充到知识库："]

const ERR_HINT: Record<ExtractErrorCode, string> = {
  timeout: "请求超时",
  auth: "鉴权失败",
  rate_limit: "触发限流",
  unsafe: "内容被拦截",
  parse_error: "解析失败",
  partial: "部分成功",
  truncated: "输出被截断",
}

export function RecordForm({ customers, aiLabel, vlLabel, initial, defaultCustomer, schemaState, siteSuggestions = [] }: Props) {
  const router = useRouter()
  const editing = Boolean(initial)
  const [d, setD] = useState<RecordDraft>(() => {
    const base = initial ? { ...initial } : emptyDraft(defaultCustomer ?? "")
    return { ...base, extras: base.extras ?? {} }
  })
  const [me, setMe] = useState("")
  const [extracting, setExtracting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [warning, setWarning] = useState<string>()
  const [extracted, setExtracted] = useState(editing)
  const [confirmed, setConfirmed] = useState(editing)
  const [shots, setShots] = useState<Shot[]>([])
  const [showPaste, setShowPaste] = useState(false)
  const [lastSource, setLastSource] = useState<"screenshot" | "paste" | undefined>()
  const [vlError, setVlError] = useState<string>()
  const [handlerOpenIds, setHandlerOpenIds] = useState<string[]>([])
  const [savePhase, setSavePhase] = useState<"idle" | "local" | "create" | "upload" | "attach" | "done">("idle")
  const [copyFallback, setCopyFallback] = useState<string | null>(null)
  const [feishuMeta, setFeishuMeta] = useState<{
    configured: boolean
    error?: string
    options: {
      company: string[]
      status: string[]
      product: string[]
      resolveMethod: string[]
      supportType: string[]
      site: string[]
    }
    handlers: { name: string; open_id: string }[]
    mode?: "cli" | "api"
  } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const transcriptBaseline = useRef<string | null>(null)
  const dragRef = useRef(false)
  const shotsRef = useRef(shots)
  useEffect(() => {
    shotsRef.current = shots
  }, [shots])

  useEffect(() => {
    const saved = localStorage.getItem("ae.me")
    // localStorage is only readable after hydration
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setMe(saved)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/feishu/meta")
        const data = await res.json()
        if (!cancelled) setFeishuMeta(data)
      } catch {
        if (!cancelled)
          setFeishuMeta({
            configured: false,
            error: "无法加载飞书字段元数据",
            options: { company: [], status: [], product: [], resolveMethod: [], supportType: [], site: [] },
            handlers: [],
          })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return () => {
      for (const s of shots) URL.revokeObjectURL(s.url)
    }
    // only on unmount; shots cleaned when removed individually
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const set = <K extends keyof RecordDraft>(k: K, v: RecordDraft[K]) => setD((p) => ({ ...p, [k]: v }))
  const setNeed = (i: number, patch: Partial<Need>) =>
    set("needs", d.needs.map((n, j) => (j === i ? { ...n, ...patch } : n)))

  async function addFiles(list: FileList | File[]) {
    const incoming = [...list].filter((f) => f.type.startsWith("image/"))
    if (!incoming.length) {
      toast.error("请选择图片文件")
      return
    }
    const room = MAX_SHOTS - shotsRef.current.length
    if (room <= 0) {
      toast.error(`最多 ${MAX_SHOTS} 张截图，无法再加入`)
      return
    }
    if (incoming.length > room) {
      toast.error(`最多 ${MAX_SHOTS} 张，第 ${MAX_SHOTS + 1} 张及之后未加入`)
    }
    const accepted = incoming.slice(0, room)
    const next: Shot[] = []
    for (const f of accepted) {
      const compressed = await compressImageFile(f)
      next.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file: compressed, url: URL.createObjectURL(compressed) })
    }
    setShots((p) => {
      const left = MAX_SHOTS - p.length
      if (left <= 0) {
        for (const s of next) URL.revokeObjectURL(s.url)
        return p
      }
      const take = next.slice(0, left)
      for (const s of next.slice(left)) URL.revokeObjectURL(s.url)
      return [...p, ...take]
    })
    setConfirmed(false)
    setVlError(undefined)
  }

  function filesFromClipboard(data: DataTransfer | null): File[] {
    if (!data) return []
    const out: File[] = []
    const seen = new Set<string>()
    const push = (f: File | null) => {
      if (!f || !f.type.startsWith("image/")) return
      const key = `${f.name}-${f.size}-${f.lastModified}-${f.type}`
      if (seen.has(key)) return
      seen.add(key)
      out.push(f)
    }
    if (data.items) {
      for (const item of Array.from(data.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) push(item.getAsFile())
      }
    }
    if (data.files?.length) {
      for (const f of Array.from(data.files)) push(f)
    }
    return out
  }

  function handleShotPaste(e: { clipboardData: DataTransfer | null; preventDefault(): void; stopPropagation(): void }) {
    const files = filesFromClipboard(e.clipboardData)
    if (!files.length) return
    e.preventDefault()
    e.stopPropagation()
    void addFiles(files)
  }

  useEffect(() => {
    const onWinPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t) {
        const tag = t.tagName
        if (tag === "TEXTAREA" || tag === "INPUT" || t.isContentEditable) return
      }
      const files = filesFromClipboard(e.clipboardData)
      if (!files.length) return
      e.preventDefault()
      void addFiles(files)
    }
    window.addEventListener("paste", onWinPaste)
    return () => window.removeEventListener("paste", onWinPaste)
  }, [])

  function removeShot(id: string) {
    setShots((p) => {
      const hit = p.find((s) => s.id === id)
      if (hit) URL.revokeObjectURL(hit.url)
      return p.filter((s) => s.id !== id)
    })
    setConfirmed(false)
  }

  function moveShot(id: string, dir: -1 | 1) {
    setShots((p) => {
      const i = p.findIndex((s) => s.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= p.length) return p
      const copy = [...p]
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
      return copy
    })
    setConfirmed(false)
  }

  async function extract() {
    const pasteReady = showPaste && d.chat.trim().length > 0
    const useShots = shots.length > 0 && !pasteReady
    if (!useShots && !d.chat.trim()) {
      toast.error("请先上传截图，或展开粘贴文字")
      return
    }
    if (
      transcriptBaseline.current != null &&
      d.chat !== transcriptBaseline.current &&
      d.chat.includes(OCR_TRANSCRIPT_MARKER)
    ) {
      const ok = window.confirm("转写已修改。继续整理会覆盖当前转写，要继续吗？")
      if (!ok) return
    }
    setExtracting(true)
    setWarning(undefined)
    setVlError(undefined)
    setConfirmed(false)
    try {
      localStorage.setItem("ae.me", me)
      let res: Response
      if (useShots) {
        const form = new FormData()
        for (const s of shots) form.append("images", s.file, s.file.name)
        form.append("customer", d.customer)
        form.append("me", me)
        res = await fetch("/api/extract", { method: "POST", body: form })
      } else {
        res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat: d.chat, customer: d.customer, me }),
        })
      }
      const data = (await res.json()) as ExtractResult & { error?: string; code?: ExtractErrorCode }
      if (!res.ok) {
        const hint = data.code ? ERR_HINT[data.code] : "失败"
        const msg = data.error || hint
        if (useShots) {
          setVlError(msg)
          setShowPaste(true)
        }
        throw new Error(msg)
      }
      if (!data.draft || typeof data.draft !== "object") {
        throw new Error("提取结果为空")
      }
      const source = data.source ?? (useShots ? "screenshot" : "paste")
      const nextChat = resolveExtractedChat(source, d.chat, data.draft.chat)
      transcriptBaseline.current = source === "screenshot" ? nextChat : null
      setD((p) => {
        const merged = mergeExtractedDraft(p, data.draft, schemaState.ok ? schemaState.schema : null)
        return { ...merged, customer: p.customer || merged.customer, thoughts: p.thoughts, chat: nextChat }
      })
      setWarning(data.warning)
      setExtracted(true)
      setLastSource(source)
      if (source === "screenshot") setShowPaste(false)
      toast.success(data.mode === "ai" ? "AI 已整理，请核对黄色区域后确认" : "已用规则初步提取，请核对")
    } catch (e) {
      toast.error(`整理失败：${(e as Error).message}`)
    } finally {
      setExtracting(false)
    }
  }

  async function save() {
    if (!editing) {
      if ((shots.length > 0 || extracted) && !confirmed) {
        toast.error("请先在黄色区域核对并点「确认无误」")
        return
      }
    }
    if (!d.customer.trim()) {
      toast.error("请填写客户名称")
      return
    }
    if (!d.title.trim() && !d.problem.trim()) {
      toast.error("至少填写标题或问题描述")
      return
    }
    setSaving(true)
    setSavePhase("local")
    try {
      const resolutionCol = schemaState.ok
        ? schemaState.schema.columns.find((c) => c.key === "resolution")
        : undefined
      const resolutionCheck = checkResolutionStatus(d.resolution, d.status, resolutionCol?.consistency)
      const bodyDraft = {
        ...d,
        title: d.title.trim() || d.problem.trim().slice(0, 24),
        extras: d.extras ?? {},
        resolution: resolutionCheck.hint ? "" : d.resolution,
        uncertain: resolutionCheck.hint
          ? [...d.uncertain, ...resolutionCheck.uncertain.filter((u) => !d.uncertain.includes(u))]
          : d.uncertain,
      }
      const feishuSide = {
        handlerOpenIds,
        push: !editing,
      }
      let res: Response
      if (initial) {
        res = await fetch(
          `/api/records/${encodeURIComponent(initial.customer)}/${encodeURIComponent(initial.file.replace(/\.md$/, ""))}`,
          { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bodyDraft) },
        )
      } else if (shots.length > 0) {
        const form = new FormData()
        form.append("draft", JSON.stringify(bodyDraft))
        form.append("feishu", JSON.stringify(feishuSide))
        for (const s of shots) form.append("screenshots", s.file, s.file.name)
        res = await fetch("/api/records", { method: "POST", body: form })
      } else {
        res = await fetch("/api/records", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...bodyDraft, feishu: feishuSide }),
        })
      }
      const data = (await res.json()) as SupportRecord & {
        error?: string
        screenshots?: string[]
        feishu?: FeishuPushResult
      }
      if (!res.ok) throw new Error(data.error || "保存失败")

      const fr = data.feishu
      if (fr) {
        for (const st of fr.steps) {
          if (st.step === "create") setSavePhase("create")
          if (st.step === "upload") setSavePhase("upload")
          if (st.step === "attach") setSavePhase("attach")
        }
        setSavePhase("done")
        if (fr.warnings?.length) {
          for (const w of fr.warnings) toast.message(w)
        }
        if (fr.ok) {
          toast.success(fr.recordId ? `已保存，飞书行 ${fr.recordId}` : "已保存并写入飞书")
        } else {
          const stepFail = fr.steps.filter((x) => !x.ok).map((x) => x.step).join(",")
          toast.error(`本地已保存；飞书未完成（${stepFail || "未知"}）：${fr.error || "失败"}。可用「复制为飞书行」降级`)
          if (!schemaState.ok) {
            toast.error(`没有复制到剪贴板：表结构配置不可用。${schemaState.error}`)
          } else {
            const clip = feishuClipboard([data as SupportRecord], schemaState.schema)
            if (!clip.text) {
              toast.error("没有复制到剪贴板：生成的行是空的")
            } else {
              try {
                await copyText(clip.text)
                for (const w of clip.warnings) toast.message(w)
                toast.message("已把本行复制到剪贴板，可粘贴到飞书表格")
              } catch (e) {
                const err = e instanceof CopyTextError ? e : new CopyTextError((e as Error).message, clip.text)
                setCopyFallback(err.text || clip.text)
                toast.error(`没有复制到剪贴板。${err.message}`)
              }
            }
          }
        }
      } else {
        toast.success("已保存到知识库")
      }
      router.push(recordHref(data))
      router.refresh()
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`)
      setSaving(false)
      setSavePhase("idle")
    }
  }

  const handlers = feishuMeta?.handlers ?? []
  const schema = schemaState.ok ? schemaState.schema : null
  const covered = schema ? schemaColumnKeys(schema) : new Set<string>()
  const personColumns = schema?.columns.filter((c) => c.type === "person") ?? []
  const attachmentColumns = schema?.columns.filter((c) => c.type === "attachment") ?? []
  const resolutionCol = schema?.columns.find((c) => c.key === "resolution")
  const consistencyHint = checkResolutionStatus(d.resolution, d.status, resolutionCol?.consistency).hint

  const canSave = editing || confirmed || (!shots.length && !extracted)
  const saveBlockedReason =
    !editing && (shots.length > 0 || extracted) && !confirmed ? "需先核对黄区并确认" : null

  return (
    <div className="grid gap-6 pb-24 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      {copyFallback && (
        <div className="lg:col-span-2">
          <CopyFallback text={copyFallback} />
        </div>
      )}
      <Card className="h-fit lg:sticky lg:top-8">
        <CardHeader>
          <CardTitle>① 上传聊天截图</CardTitle>
          <CardDescription>
            主路径：微信/飞书聊天截图（最多 {MAX_SHOTS} 张，可调序）。未确认前只在浏览器内存，不会写入客户目录。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="customer">客户 *</Label>
              <Input
                id="customer"
                list="customer-list"
                value={d.customer}
                disabled={editing}
                placeholder="如：宁德某电池厂"
                onChange={(e) => set("customer", e.target.value)}
              />
              <datalist id="customer-list">
                {customers.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="me">我在聊天里的昵称</Label>
              <Input id="me" value={me} placeholder="用于区分我方和客户" onChange={(e) => setMe(e.target.value)} />
            </div>
          </div>

          {!editing && (
            <>
              <div
                role="button"
                tabIndex={0}
                className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/40 bg-primary/5 px-4 py-10 text-center transition hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => fileRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    fileRef.current?.click()
                  }
                }}
                onPaste={handleShotPaste}
                onDragEnter={(e) => {
                  e.preventDefault()
                  dragRef.current = true
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  dragRef.current = false
                  if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files)
                }}
              >
                <ImagePlus className="size-8 text-primary" />
                <div className="text-sm font-medium">点击、拖拽或 Ctrl+V 粘贴截图</div>
                <div className="text-xs text-muted-foreground">支持 JPG/PNG/WebP · 最多 {MAX_SHOTS} 张 · 可连续粘贴累加</div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) void addFiles(e.target.files)
                    e.target.value = ""
                  }}
                />
              </div>

              {shots.length > 0 && (
                <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {shots.map((s, i) => (
                    <li key={s.id} className="group relative overflow-hidden rounded-lg border bg-muted/40">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.url} alt={`截图 ${i + 1}`} className="aspect-[3/4] w-full object-cover" />
                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-0.5 bg-black/55 p-0.5">
                        <span className="px-1 text-[10px] text-white">{i + 1}</span>
                        <div className="flex">
                          <Button type="button" size="icon-xs" variant="ghost" className="text-white hover:bg-white/20" aria-label="上移" disabled={i === 0} onClick={() => moveShot(s.id, -1)}>
                            <ArrowUp className="size-3" />
                          </Button>
                          <Button type="button" size="icon-xs" variant="ghost" className="text-white hover:bg-white/20" aria-label="下移" disabled={i === shots.length - 1} onClick={() => moveShot(s.id, 1)}>
                            <ArrowDown className="size-3" />
                          </Button>
                          <Button type="button" size="icon-xs" variant="ghost" className="text-white hover:bg-white/20" aria-label="删除" onClick={() => removeShot(s.id)}>
                            <Trash2 className="size-3" />
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={extract} disabled={extracting || editing}>
              {extracting ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {extracting
                ? "整理中…"
                : showPaste && d.chat.trim()
                  ? "用粘贴文字整理"
                  : extracted
                    ? "重新整理"
                    : shots.length
                      ? "从截图提取"
                      : "AI 整理"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowPaste((v) => !v)}>
              {showPaste ? "收起文字粘贴" : "改用粘贴文字"}
            </Button>
            <span className="text-xs text-muted-foreground">
              截图：{vlLabel ?? "通义 VL"} · 文字：{aiLabel}
            </span>
          </div>

          {vlError && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <p className="font-medium">截图提取失败</p>
              <p className="mt-1">{vlError}</p>
              <p className="mt-2 text-xs">
                {showPaste
                  ? "文字粘贴已展开。贴上聊天后点「用粘贴文字整理」。已上传的截图仍会在确认保存后备份。"
                  : "点「改用粘贴文字」，贴上聊天后再整理。已上传的截图仍会在确认保存后备份。"}
              </p>
            </div>
          )}

          {(showPaste || editing || (!shots.length && d.chat)) && (
            <div className="space-y-2 rounded-lg border border-dashed p-3">
              <Label>{d.chat.startsWith(OCR_TRANSCRIPT_MARKER) ? "原始聊天记录" : "文字粘贴（次要）"}</Label>
              <Textarea
                value={d.chat}
                onChange={(e) => {
                  set("chat", e.target.value)
                  if (!editing) setConfirmed(false)
                }}
                placeholder={"张工 2026-10-28 09:12\n极耳定位又偏了……\n小李 2026-10-28 09:15\n偏多少？有截图吗？"}
                className="min-h-48 font-mono text-xs leading-relaxed"
              />
              {!d.chat && !editing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    set("chat", SAMPLE_CHAT)
                    if (!d.customer) set("customer", "宁德某电池厂")
                    if (!me) setMe("小李")
                    setShowPaste(true)
                  }}
                >
                  <Wand2 />
                  填入示例
                </Button>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">没有聊天记录（电话、现场）？可直接在右侧填写后保存。</p>
        </CardContent>
      </Card>

      <div className="space-y-6">
        {extracted && (
          <Card className="border-amber-300 bg-amber-50/60 ring-amber-200">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-amber-900">
                <AlertTriangle className="size-4" />
                需要你核对的地方（不可跳过）
              </CardTitle>
              <CardDescription className="text-amber-800/80">
                AI 草稿仅供参考。请对照截图/原文改右侧字段；确认后才能保存。来源：{lastSource === "screenshot" ? "截图 VL" : lastSource === "paste" ? "文字" : "—"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {shots.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {shots.map((s, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={s.id} src={s.url} alt={`核对图 ${i + 1}`} className="h-24 w-auto rounded border object-cover" />
                  ))}
                </div>
              )}
              {lastSource === "screenshot" && (
                <div className="space-y-1.5">
                  <Label htmlFor="ocr-transcript">原始聊天记录（可改）</Label>
                  <p className="text-xs text-amber-900/80">
                    对照上方截图改转写。首行是 {OCR_TRANSCRIPT_MARKER}，之后每行「发言人：内容」。改动后需重新确认。保存后这一节视为原始记录。
                  </p>
                  <Textarea
                    id="ocr-transcript"
                    value={d.chat}
                    onChange={(e) => {
                      set("chat", e.target.value)
                      setConfirmed(false)
                    }}
                    className="min-h-40 bg-background font-mono text-xs leading-relaxed"
                  />
                </div>
              )}
              {warning && <p className="text-sm text-amber-900">{warning}</p>}
              {consistencyHint && (
                <p className="rounded-lg bg-background/70 p-2 text-sm text-amber-950">{consistencyHint}</p>
              )}
              {d.uncertain.map((u, i) => (
                <div key={i} className="flex items-start gap-2 rounded-lg bg-background/70 p-2 text-sm">
                  <span className="flex-1">{u}</span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="已核对"
                    onClick={() => set("uncertain", d.uncertain.filter((_, j) => j !== i))}
                  >
                    <Check />
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  type="button"
                  variant={confirmed ? "secondary" : "default"}
                  onClick={() => setConfirmed(true)}
                  disabled={confirmed}
                >
                  <Check />
                  {confirmed ? "已确认" : "确认无误，可以保存"}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowPaste(true)}>
                  改用粘贴文字
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>② 核对记录</CardTitle>
            <CardDescription>
              {schema
                ? "飞书列按表结构配置的顺序显示。单选只能选配置里的选项。本地记录里配置没覆盖的字段仍可编辑。"
                : "飞书列配置缺失，下面只显示本地记录字段，不会套用旧的 11 列模板。"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!schemaState.ok && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-medium">还不能复制为飞书行</p>
                <p className="mt-1">{schemaState.error}</p>
              </div>
            )}
            {consistencyHint && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                {consistencyHint}
              </div>
            )}
            {schema && (
              <div className="grid gap-3 sm:grid-cols-2">
                {schema.columns.map((col) => (
                  <SchemaColumnField
                    key={`${col.type}-${col.name}`}
                    col={col}
                    draft={d}
                    suggestions={siteSuggestions}
                    onChange={(key, value) => {
                      setD((p) => writeRecordField(p, key, value))
                      setConfirmed(false)
                    }}
                    onMulti={(key, values) => {
                      setD((p) => ({ ...p, [key]: values }))
                      setConfirmed(false)
                    }}
                  />
                ))}
              </div>
            )}
            {(personColumns.length > 0 || attachmentColumns.length > 0) && (
              <p className="text-xs text-muted-foreground">
                {personColumns.length > 0 ? `人员列（${personColumns.map((c) => c.name).join("、")}）` : ""}
                {personColumns.length > 0 && attachmentColumns.length > 0 ? "和" : ""}
                {attachmentColumns.length > 0 ? `附件列（${attachmentColumns.map((c) => c.name).join("、")}）` : ""}
                复制时留空，避免后面的列粘贴错位。
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {LOCAL_FIELDS.filter((f) => !covered.has(f.key)).map((f) => (
                <Field key={f.key} label={f.label} className={f.multiline ? "sm:col-span-2" : undefined}>
                  {f.multiline ? (
                    <Textarea
                      value={d[f.key]}
                      onChange={(e) => { set(f.key, e.target.value); setConfirmed(false) }}
                      className="min-h-20"
                    />
                  ) : (
                    <Input
                      type={f.date ? "date" : "text"}
                      value={d[f.key]}
                      placeholder={f.key === "title" ? "一句话说清问题" : undefined}
                      onChange={(e) => { set(f.key, e.target.value); setConfirmed(false) }}
                    />
                  )}
                </Field>
              ))}
            </div>
            {!editing && (
              <div className="space-y-3 rounded-lg border border-dashed border-sky-300 bg-sky-50/50 p-3">
                <p className="text-sm font-medium text-sky-950">飞书直写（确认保存后）</p>
                <p className="text-xs text-sky-900/80">
                  {!schema
                    ? "表结构配置未就绪，不会按旧列模板写入飞书。"
                    : feishuMeta == null
                      ? "正在检查 lark-cli…"
                      : feishuMeta.configured
                        ? `默认走 lark-cli（${feishuMeta.mode || "cli"}）。建行只写配置里带 fieldId 的列。复制为飞书行是失败时的兜底。`
                        : `lark-cli 未就绪：${feishuMeta.error || "请登录 lark-cli"}。本地仍可保存；配置齐全后可用「复制为飞书行」。`}
                </p>
                {schema && <SyncOptionsButton />}
                {personColumns.length > 0 && handlers.length > 0 && (
                  <Field label={`${personColumns.map((c) => c.name).join("、")}（open_id 多选）`}>
                    <div className="flex flex-wrap gap-2">
                      {handlers.map((h) => {
                        const on = handlerOpenIds.includes(h.open_id)
                        return (
                          <label key={h.open_id} className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => {
                                setHandlerOpenIds((prev) =>
                                  on ? prev.filter((id) => id !== h.open_id) : [...prev, h.open_id],
                                )
                                setConfirmed(false)
                              }}
                            />
                            {h.name || h.open_id}
                          </label>
                        )
                      })}
                    </div>
                  </Field>
                )}
                {personColumns.length > 0 && handlers.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    未配置 LARK_HANDLERS 时不写人员列。格式见 .env.example。复制行时该列留空。
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-primary/30 ring-primary/20">
          <CardHeader>
            <CardTitle>③ 我的思考</CardTitle>
            <CardDescription>
              只有你知道的判断：根因、客户真实意图、软件哪里不好用。这一栏 AI 不会改动，最值得积累。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {THOUGHT_PROMPTS.map((p) => (
                <Button
                  key={p}
                  size="xs"
                  variant="outline"
                  onClick={() => set("thoughts", (d.thoughts ? d.thoughts.replace(/\s*$/, "") + "\n" : "") + p)}
                >
                  {p.replace("：", "")}
                </Button>
              ))}
            </div>
            <Textarea
              value={d.thoughts}
              onChange={(e) => set("thoughts", e.target.value)}
              className="min-h-28"
              placeholder="随手写几句就好，比如：换料导致反光变化是共性问题，至少 3 家客户遇到过……"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>④ 需求线索</CardTitle>
            <CardDescription>客户的抱怨、绕路做法、反复出现的操作，都会汇总到「需求池」。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {d.needs.length === 0 && <p className="text-sm text-muted-foreground">暂无。AI 整理时会自动提炼，也可以手动添加。</p>}
            {d.needs.map((n, i) => (
              <div key={i} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_8rem_auto]">
                <Textarea
                  value={n.pain}
                  onChange={(e) => { setNeed(i, { pain: e.target.value }); setConfirmed(false) }}
                  placeholder="痛点"
                  className="min-h-14"
                />
                <Textarea
                  value={n.idea}
                  onChange={(e) => { setNeed(i, { idea: e.target.value }); setConfirmed(false) }}
                  placeholder="改进/工具想法"
                  className="min-h-14"
                />
                <select className={selectClass} value={n.type} onChange={(e) => { setNeed(i, { type: e.target.value as Need["type"] }); setConfirmed(false) }}>
                  {NEED_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="删除"
                  onClick={() => { set("needs", d.needs.filter((_, j) => j !== i)); setConfirmed(false) }}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => set("needs", [...d.needs, { pain: "", idea: "", type: "软件改进" }])}>
              <Plus />
              添加线索
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/90 backdrop-blur md:left-56">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 md:px-8">
          <span className="truncate text-xs text-muted-foreground">
            保存为 Markdown：customers/{d.customer || "<客户>"}/records/
            {shots.length > 0 ? ` + files/${d.date || "聊天日期"}-标题-1..${shots.length}.jpg` : ""}
            {saveBlockedReason ? ` · ${saveBlockedReason}` : ""}
            {saving && !editing
              ? ` · 进度：${
                  savePhase === "local"
                    ? "本地"
                    : savePhase === "create"
                      ? "本地→建行"
                      : savePhase === "upload"
                        ? "本地→建行→上传"
                        : savePhase === "attach"
                          ? "本地→建行→附件"
                          : savePhase === "done"
                            ? "完成"
                            : "…"
                }`
              : ""}
          </span>
          <Button onClick={save} disabled={saving || !canSave}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            {editing ? "保存修改" : "确认保存并写飞书"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function SyncOptionsButton() {
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{
    applied?: boolean
    changes: { name: string; added: string[]; removed: string[] }[]
    missingInFeishu: string[]
    missingInConfig: string[]
    path: string
  } | null>(null)

  async function run(apply: boolean) {
    setBusy(true)
    try {
      const res = await fetch("/api/feishu/schema/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "同步失败")
      setPreview(data)
      if (apply) toast.success(data.changes?.length ? `已更新 ${data.changes.length} 列的选项` : "选项没有变化")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run(false)}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        从飞书同步选项
      </Button>
      {preview && !preview.applied && (
        <div className="space-y-2 rounded-md border bg-background p-2 text-xs">
          <p>只改选项，不改列名、key 或 AI 规则。写入前请确认差异。文件：{preview.path}</p>
          {preview.changes.length === 0 && <p>没有选项变化。</p>}
          {preview.changes.map((c) => (
            <p key={c.name}>
              {c.name}：新增 {c.added.join("、") || "无"}；去掉 {c.removed.join("、") || "无"}
            </p>
          ))}
          {preview.missingInFeishu.length > 0 && <p>配置里有、飞书没有：{preview.missingInFeishu.join("、")}</p>}
          {preview.missingInConfig.length > 0 && <p>飞书有选项、配置里没有同名列：{preview.missingInConfig.join("、")}</p>}
          {preview.changes.length > 0 && (
            <Button type="button" size="sm" disabled={busy} onClick={() => void run(true)}>
              确认写入选项
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function SchemaColumnField({
  col,
  draft,
  suggestions,
  onChange,
  onMulti,
}: {
  col: FeishuColumn
  draft: RecordDraft
  suggestions: string[]
  onChange: (key: string, value: string) => void
  onMulti: (key: "dimensions" | "inspection_types" | "industries", values: string[]) => void
}) {
  if (col.type === "person" || col.type === "attachment" || !col.key) return null
  if (col.key === "needs") {
    return (
      <p className="text-xs text-muted-foreground sm:col-span-2">
        「{col.name}」对应需求线索，在下方第④节编辑。复制时写成「痛点 → 想法」，多条用分号分隔。
      </p>
    )
  }
  if (col.key === "local_id") {
    return (
      <Field label={col.name}>
        <Input value={draft.local_id} readOnly placeholder="保存或复制时自动生成" />
      </Field>
    )
  }
  if (col.type === "multi" && (col.key === "dimensions" || col.key === "inspection_types" || col.key === "industries")) {
    const selected = readMulti(draft, col.key)
    return (
      <Field label={col.name} className="sm:col-span-2">
        <div className="flex flex-wrap gap-2">
          {col.options.map((opt) => {
            const on = selected.includes(opt)
            return (
              <label key={opt} className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onMulti(col.key as "dimensions" | "inspection_types" | "industries", on ? selected.filter((v) => v !== opt) : [...selected, opt])}
                />
                {opt}
              </label>
            )
          })}
        </div>
      </Field>
    )
  }
  const value = readRecordField(draft, col.key)
  if (col.key === "site") {
    const siteOptions = [...new Set([...(col.suggestions ?? []), ...suggestions])]
    return (
      <Field label={col.name}>
        <Input list="site-suggestions" value={value} onChange={(e) => onChange(col.key!, e.target.value)} placeholder="输入时会按历史项目/现场补全" />
        <datalist id="site-suggestions">
          {siteOptions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </Field>
    )
  }
  if (col.type === "select") {
    const orphan = value && !col.options.includes(value) ? value : ""
    return (
      <Field label={col.name}>
        <select className={selectClass} value={value} onChange={(e) => onChange(col.key!, e.target.value)}>
          <option value="">（留空）</option>
          {col.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
          {orphan && <option value={orphan}>{orphan}（不在配置选项中）</option>}
        </select>
      </Field>
    )
  }
  if (col.multiline) {
    return (
      <Field label={col.name} className="sm:col-span-2">
        <Textarea value={value} onChange={(e) => onChange(col.key!, e.target.value)} className="min-h-20" />
      </Field>
    )
  }
  return (
    <Field label={col.name}>
      <Input type={col.key === "date" ? "date" : "text"} value={value} onChange={(e) => onChange(col.key!, e.target.value)} />
    </Field>
  )
}
