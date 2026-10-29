"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { AlertTriangle, Check, Loader2, Plus, Save, Sparkles, Trash2, Wand2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { recordHref, selectClass } from "@/components/bits"
import {
  CATEGORIES,
  CHANNELS,
  NEED_TYPES,
  STATUSES,
  emptyDraft,
  type ExtractResult,
  type Need,
  type RecordDraft,
  type SupportRecord,
} from "@/lib/types"

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

type Props = {
  customers: string[]
  aiLabel: string
  initial?: SupportRecord
  defaultCustomer?: string
}

const THOUGHT_PROMPTS = ["根因判断：", "客户真正想要的是：", "软件可以改进：", "下次遇到可以直接：", "需要补充到知识库："]

export function RecordForm({ customers, aiLabel, initial, defaultCustomer }: Props) {
  const router = useRouter()
  const editing = Boolean(initial)
  const [d, setD] = useState<RecordDraft>(() => (initial ? { ...initial } : emptyDraft(defaultCustomer ?? "")))
  const [me, setMe] = useState("")
  const [extracting, setExtracting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [warning, setWarning] = useState<string>()
  const [extracted, setExtracted] = useState(editing)

  useEffect(() => {
    const saved = localStorage.getItem("ae.me")
    // localStorage is only readable after hydration
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setMe(saved)
  }, [])

  const set = <K extends keyof RecordDraft>(k: K, v: RecordDraft[K]) => setD((p) => ({ ...p, [k]: v }))
  const setNeed = (i: number, patch: Partial<Need>) =>
    set("needs", d.needs.map((n, j) => (j === i ? { ...n, ...patch } : n)))

  async function extract() {
    if (!d.chat.trim()) {
      toast.error("先粘贴聊天记录")
      return
    }
    setExtracting(true)
    setWarning(undefined)
    try {
      localStorage.setItem("ae.me", me)
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat: d.chat, customer: d.customer, me }),
      })
      const data = (await res.json()) as ExtractResult & { error?: string }
      if (!res.ok) throw new Error(data.error)
      setD((p) => ({
        ...p,
        ...Object.fromEntries(Object.entries(data.draft).filter(([, v]) => v !== undefined && v !== "")),
        customer: p.customer,
        chat: p.chat,
        thoughts: p.thoughts,
      }))
      setWarning(data.warning)
      setExtracted(true)
      toast.success(data.mode === "ai" ? "AI 已整理，请核对黄色提示的内容" : "已用规则初步提取，请核对")
    } catch (e) {
      toast.error(`整理失败：${(e as Error).message}`)
    } finally {
      setExtracting(false)
    }
  }

  async function save() {
    if (!d.customer.trim()) {
      toast.error("请填写客户名称")
      return
    }
    if (!d.title.trim() && !d.problem.trim()) {
      toast.error("至少填写标题或问题描述")
      return
    }
    setSaving(true)
    try {
      const body = { ...d, title: d.title.trim() || d.problem.trim().slice(0, 24) }
      const res = await fetch(
        initial
          ? `/api/records/${encodeURIComponent(initial.customer)}/${encodeURIComponent(initial.file.replace(/\.md$/, ""))}`
          : "/api/records",
        { method: initial ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success("已保存到知识库")
      router.push(recordHref(data))
      router.refresh()
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`)
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-6 pb-24 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <Card className="h-fit lg:sticky lg:top-8">
        <CardHeader>
          <CardTitle>① 粘贴聊天记录</CardTitle>
          <CardDescription>
            从微信或飞书多选消息后复制粘贴。原文会完整保存在这条记录里，作为备份。
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
          <Textarea
            value={d.chat}
            onChange={(e) => set("chat", e.target.value)}
            placeholder={"张工 2026-10-28 09:12\n极耳定位又偏了……\n小李 2026-10-28 09:15\n偏多少？有截图吗？"}
            className="min-h-72 font-mono text-xs leading-relaxed"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={extract} disabled={extracting}>
              {extracting ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {extracting ? "整理中…" : extracted ? "重新整理" : "AI 整理"}
            </Button>
            {!d.chat && (
              <Button
                variant="outline"
                onClick={() => {
                  set("chat", SAMPLE_CHAT)
                  if (!d.customer) set("customer", "宁德某电池厂")
                  if (!me) setMe("小李")
                }}
              >
                <Wand2 />
                填入示例
              </Button>
            )}
            <span className="text-xs text-muted-foreground">模型：{aiLabel}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            没有聊天记录（电话、现场）？直接在右侧填写即可。
          </p>
        </CardContent>
      </Card>

      <div className="space-y-6">
        {(warning || d.uncertain.length > 0) && (
          <Card className="border-amber-300 bg-amber-50/60 ring-amber-200">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-amber-900">
                <AlertTriangle className="size-4" />
                需要你核对的地方
              </CardTitle>
              <CardDescription className="text-amber-800/80">
                AI 不确定的点都列在这里。核对后点 ✓ 移除；保留的会存进记录的「待确认」。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
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
              <Input id="title" value={d.title} onChange={(e) => set("title", e.target.value)} placeholder="一句话说清问题" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="日期">
                <Input type="date" value={d.date} onChange={(e) => set("date", e.target.value)} />
              </Field>
              <Field label="联系人">
                <Input value={d.contact} onChange={(e) => set("contact", e.target.value)} />
              </Field>
              <Field label="渠道">
                <select className={selectClass} value={d.channel} onChange={(e) => set("channel", e.target.value as RecordDraft["channel"])}>
                  {CHANNELS.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="状态">
                <select className={selectClass} value={d.status} onChange={(e) => set("status", e.target.value as RecordDraft["status"])}>
                  {STATUSES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="产品/版本">
                <Input value={d.product} onChange={(e) => set("product", e.target.value)} placeholder="如 VisionMaster 4.3" />
              </Field>
              <Field label="模块">
                <Input value={d.module} onChange={(e) => set("module", e.target.value)} placeholder="定位 / 标定 / 测量…" />
              </Field>
              <Field label="问题分类" className="sm:col-span-2">
                <select className={selectClass} value={d.category} onChange={(e) => set("category", e.target.value)}>
                  {[...new Set([...CATEGORIES, d.category])].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="问题描述">
              <Textarea value={d.problem} onChange={(e) => set("problem", e.target.value)} className="min-h-20" />
            </Field>
            <Field label="处理过程">
              <Textarea value={d.process} onChange={(e) => set("process", e.target.value)} className="min-h-24" />
            </Field>
            <Field label="解决方案 / 当前结论">
              <Textarea value={d.solution} onChange={(e) => set("solution", e.target.value)} className="min-h-20" />
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
                  onChange={(e) => setNeed(i, { pain: e.target.value })}
                  placeholder="痛点"
                  className="min-h-14"
                />
                <Textarea
                  value={n.idea}
                  onChange={(e) => setNeed(i, { idea: e.target.value })}
                  placeholder="改进/工具想法"
                  className="min-h-14"
                />
                <select className={selectClass} value={n.type} onChange={(e) => setNeed(i, { type: e.target.value as Need["type"] })}>
                  {NEED_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="删除"
                  onClick={() => set("needs", d.needs.filter((_, j) => j !== i))}
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
          </span>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            {editing ? "保存修改" : "保存记录"}
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
