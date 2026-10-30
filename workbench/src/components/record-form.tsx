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
import {
  CATEGORIES,
  CHANNELS,
  NEED_TYPES,
  STATUSES,
  emptyDraft,
  type ExtractErrorCode,
  type ExtractResult,
  type FeishuPushResult,
  type Need,
  type RecordDraft,
  type SupportRecord,
} from "@/lib/types"
import { toTsvRows } from "@/lib/feishu"
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
}

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

export function RecordForm({ customers, aiLabel, vlLabel, initial, defaultCustomer }: Props) {
  const router = useRouter()
  const editing = Boolean(initial)
  const [d, setD] = useState<RecordDraft>(() => (initial ? { ...initial } : emptyDraft(defaultCustomer ?? "")))
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
  const [companyOption, setCompanyOption] = useState("")
  const [savePhase, setSavePhase] = useState<"idle" | "local" | "create" | "upload" | "attach" | "done">("idle")
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

  const companyList = feishuMeta?.options.company
  const companyKey = `${d.customer}\0${(companyList ?? []).join("\0")}`
  const [seenCompanyKey, setSeenCompanyKey] = useState(companyKey)
  if (seenCompanyKey !== companyKey) {
    setSeenCompanyKey(companyKey)
    const hit = companyList?.find((c) => c === d.customer.trim())
    if (hit) setCompanyOption(hit)
  }

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
      setD((p) => ({
        ...p,
        ...Object.fromEntries(Object.entries(data.draft).filter(([, v]) => v !== undefined && v !== "")),
        customer: p.customer,
        thoughts: p.thoughts,
        chat: resolveExtractedChat(source, p.chat, data.draft.chat),
      }))
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
      const bodyDraft = { ...d, title: d.title.trim() || d.problem.trim().slice(0, 24) }
      const feishuSide = {
        companyOption: companyOption || undefined,
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
          try {
            await navigator.clipboard.writeText(toTsvRows([data as SupportRecord]))
            toast.message("已把本行复制到剪贴板，可粘贴到飞书表格")
          } catch {
            /* ignore */
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

  const statusOptions =
    feishuMeta?.options.status?.length ? feishuMeta.options.status : [...STATUSES]
  const companyOptions = feishuMeta?.options.company ?? []
  const handlers = feishuMeta?.handlers ?? []

  const canSave = editing || confirmed || (!shots.length && !extracted)
  const saveBlockedReason =
    !editing && (shots.length > 0 || extracted) && !confirmed ? "需先核对黄区并确认" : null

  return (
    <div className="grid gap-6 pb-24 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
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
            <CardDescription>这些字段会进入飞书表格和客户时间线。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="title">标题</Label>
              <Input id="title" value={d.title} onChange={(e) => { set("title", e.target.value); setConfirmed(false) }} placeholder="一句话说清问题" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="日期">
                <Input type="date" value={d.date} onChange={(e) => { set("date", e.target.value); setConfirmed(false) }} />
              </Field>
              <Field label="联系人">
                <Input value={d.contact} onChange={(e) => { set("contact", e.target.value); setConfirmed(false) }} />
              </Field>
              <Field label="渠道">
                <select className={selectClass} value={d.channel} onChange={(e) => { set("channel", e.target.value as RecordDraft["channel"]); setConfirmed(false) }}>
                  {CHANNELS.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="处理状态（飞书）">
                <select className={selectClass} value={d.status} onChange={(e) => { set("status", e.target.value); setConfirmed(false) }}>
                  {[...new Set([...statusOptions, d.status].filter(Boolean))].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="产品/版本">
                <Input value={d.product} onChange={(e) => { set("product", e.target.value); setConfirmed(false) }} placeholder="如 VisionMaster 4.3" />
              </Field>
              <Field label="模块">
                <Input value={d.module} onChange={(e) => { set("module", e.target.value); setConfirmed(false) }} placeholder="定位 / 标定 / 测量…" />
              </Field>
              <Field label="问题分类" className="sm:col-span-2">
                <select className={selectClass} value={d.category} onChange={(e) => { set("category", e.target.value); setConfirmed(false) }}>
                  {[...new Set([...CATEGORIES, d.category])].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </div>
            {!editing && (
              <div className="space-y-3 rounded-lg border border-dashed border-sky-300 bg-sky-50/50 p-3">
                <p className="text-sm font-medium text-sky-950">飞书直写（确认保存后）</p>
                <p className="text-xs text-sky-900/80">
                  {feishuMeta == null
                    ? "正在加载飞书字段…"
                    : feishuMeta.configured
                      ? `默认走本机 lark-cli（${feishuMeta.mode || "cli"}）；未命中的 select 会跳过或写入「其他-待确认」。`
                      : `飞书未就绪：${feishuMeta.error || "请安装并登录 lark-cli（config init）"}。本地仍可保存，可用行复制降级。`}
                </p>
                <Field label="客户公司（飞书 select）">
                  <select
                    className={selectClass}
                    value={companyOption}
                    onChange={(e) => {
                      setCompanyOption(e.target.value)
                      setConfirmed(false)
                    }}
                  >
                    <option value="">（按客户名自动匹配；未命中→其他-待确认）</option>
                    {companyOptions.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>
                {handlers.length > 0 && (
                  <Field label="处理人（open_id 多选）">
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
                {handlers.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    未配置 LARK_HANDLERS 时不写处理人字段。格式见 .env.example。
                  </p>
                )}
              </div>
            )}
            <Field label="问题描述">
              <Textarea value={d.problem} onChange={(e) => { set("problem", e.target.value); setConfirmed(false) }} className="min-h-20" />
            </Field>
            <Field label="处理过程">
              <Textarea value={d.process} onChange={(e) => { set("process", e.target.value); setConfirmed(false) }} className="min-h-24" />
            </Field>
            <Field label="解决方案 / 当前结论">
              <Textarea value={d.solution} onChange={(e) => { set("solution", e.target.value); setConfirmed(false) }} className="min-h-20" />
            </Field>
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
            {shots.length > 0 ? ` + files/截图-日期-1..${shots.length}.jpg` : ""}
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

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label>{label}</Label>
      {children}
    </div>
  )
}
