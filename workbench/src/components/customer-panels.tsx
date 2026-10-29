"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Bot, FileText, Loader2, Pencil, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { selectClass } from "@/components/bits"
import { CUSTOMER_STAGES, type CustomerProfile } from "@/lib/types"

const FIELDS: { key: keyof CustomerProfile; label: string; placeholder: string }[] = [
  { key: "industry", label: "行业/场景", placeholder: "锂电 · 极耳定位、涂布检测" },
  { key: "products", label: "软件/版本", placeholder: "VisionMaster 4.3、SDK 2.1" },
  { key: "hardware", label: "硬件配置", placeholder: "500 万面阵 ×4、环形光源、i7 工控机" },
  { key: "contacts", label: "联系人", placeholder: "张工（设备）、王经理（采购）" },
]

export function ProfileEditor({ profile }: { profile: CustomerProfile }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [p, setP] = useState(profile)
  const [saving, setSaving] = useState(false)

  if (!editing) {
    return (
      <div className="space-y-3 text-sm">
        <dl className="grid grid-cols-[5rem_1fr] gap-y-2">
          <dt className="text-muted-foreground">阶段</dt>
          <dd>{profile.stage || "—"}</dd>
          {FIELDS.map((f) => (
            <div key={f.key} className="contents">
              <dt className="text-muted-foreground">{f.label}</dt>
              <dd className="whitespace-pre-wrap">{profile[f.key] || "—"}</dd>
            </div>
          ))}
        </dl>
        {profile.notes && <p className="rounded-lg bg-muted p-2 whitespace-pre-wrap">{profile.notes}</p>}
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          <Pencil />
          编辑客户档案
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>阶段</Label>
        <select className={selectClass} value={p.stage} onChange={(e) => setP({ ...p, stage: e.target.value })}>
          <option value="">未设置</option>
          {CUSTOMER_STAGES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      {FIELDS.map((f) => (
        <div key={f.key} className="space-y-1.5">
          <Label>{f.label}</Label>
          <Input value={p[f.key]} placeholder={f.placeholder} onChange={(e) => setP({ ...p, [f.key]: e.target.value })} />
        </div>
      ))}
      <div className="space-y-1.5">
        <Label>备注</Label>
        <Textarea value={p.notes} onChange={(e) => setP({ ...p, notes: e.target.value })} placeholder="客户特点、合作背景、注意事项" />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={saving}
          onClick={async () => {
            setSaving(true)
            const res = await fetch(`/api/customers/${encodeURIComponent(profile.name)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(p),
            })
            setSaving(false)
            if (!res.ok) return toast.error("保存失败")
            toast.success("客户档案已保存")
            setEditing(false)
            router.refresh()
          }}
        >
          {saving && <Loader2 className="animate-spin" />}
          保存
        </Button>
        <Button size="sm" variant="ghost" onClick={() => (setP(profile), setEditing(false))}>
          取消
        </Button>
      </div>
    </div>
  )
}

export function FilesPanel({ customer, files }: { customer: string; files: { name: string; size: number; mtime: string }[] }) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  async function upload(list: FileList | null) {
    if (!list?.length) return
    setUploading(true)
    const form = new FormData()
    for (const f of Array.from(list)) form.append("files", f)
    const res = await fetch(`/api/customers/${encodeURIComponent(customer)}/files`, { method: "POST", body: form })
    setUploading(false)
    if (input.current) input.current.value = ""
    if (!res.ok) return toast.error("上传失败")
    toast.success(`已上传 ${list.length} 个文件`)
    router.refresh()
  }

  return (
    <div
      className="space-y-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        upload(e.dataTransfer.files)
      }}
    >
      {files.length === 0 ? (
        <p className="text-sm text-muted-foreground">图纸、现场图片、日志、方案文档都可以拖到这里。</p>
      ) : (
        <ul className="space-y-1.5">
          {files.map((f) => (
            <li key={f.name} className="flex items-center gap-2 text-sm">
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <a
                href={`/api/files/${encodeURIComponent(customer)}/${encodeURIComponent(f.name)}`}
                target="_blank"
                className="min-w-0 flex-1 truncate hover:text-primary hover:underline"
              >
                {f.name}
              </a>
              <span className="shrink-0 text-xs text-muted-foreground">{(f.size / 1024).toFixed(0)} KB</span>
            </li>
          ))}
        </ul>
      )}
      <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
      <Button variant="outline" size="sm" disabled={uploading} onClick={() => input.current?.click()}>
        {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
        上传资料
      </Button>
    </div>
  )
}

export function CopyContextButton({ text }: { text: string }) {
  return (
    <Button
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          toast.success("已复制该客户的完整资料，可以粘贴给任意 AI 让它总结或分析")
        } catch {
          toast.error("复制失败，请检查剪贴板权限")
        }
      }}
    >
      <Bot />
      复制给 AI
    </Button>
  )
}
