"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, ClipboardCopy, Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { selectClass } from "@/components/bits"
import type { FeishuSchemaState } from "@/lib/feishu-schema"
import { STATUSES, type Status, type SupportRecord } from "@/lib/types"

function apiPath(r: SupportRecord) {
  return `/api/records/${encodeURIComponent(r.customer)}/${encodeURIComponent(r.file.replace(/\.md$/, ""))}`
}

export function StatusSelect({ record, statusOptions }: { record: SupportRecord; statusOptions?: string[] }) {
  const router = useRouter()
  const [value, setValue] = useState<Status>(record.status)
  const options = [...new Set([...(statusOptions?.length ? statusOptions : STATUSES), record.status].filter(Boolean))]
  return (
    <select
      aria-label="状态"
      className={`${selectClass} w-28`}
      value={value}
      onChange={async (e) => {
        const status = e.target.value as Status
        setValue(status)
        const res = await fetch(apiPath(record), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        })
        if (res.ok) {
          toast.success(`状态已改为「${status}」`)
          if (record.local_id) toast.message(`请在飞书搜索 ${record.local_id}，修改同一行，不要新建`)
          router.refresh()
        } else toast.error("更新失败")
      }}
    >
      {options.map((s) => (
        <option key={s}>{s}</option>
      ))}
    </select>
  )
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text)
}

export function CopyFeishuButton({ record, schemaState }: { record: SupportRecord; schemaState: FeishuSchemaState }) {
  const router = useRouter()
  return (
    <Button
      variant="outline"
      onClick={async () => {
        if (!schemaState.ok) {
          toast.error(schemaState.error)
          return
        }
        try {
          const res = await fetch("/api/feishu/clipboard", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: [record.id] }),
          })
          const data = (await res.json()) as { text?: string; warnings?: string[]; already?: string[]; error?: string }
          if (!res.ok || !data.text) throw new Error(data.error || "复制失败")
          await copy(data.text)
          for (const w of data.warnings ?? []) toast.message(w)
          for (const id of data.already ?? []) toast.message(`本地记录ID ${id} 已粘贴过，请在飞书搜索该 ID，不要新建一行`)
          await fetch("/api/records/mark-synced", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: [record.id] }),
          })
          toast.success("已复制，去飞书表格「工作台粘贴」视图选中一行的第一个单元格粘贴即可")
          router.refresh()
        } catch {
          toast.error("复制失败，请检查浏览器剪贴板权限")
        }
      }}
    >
      <ClipboardCopy />
      复制为飞书行
    </Button>
  )
}

export function SyncPanel({ records, schemaState }: { records: SupportRecord[]; schemaState: FeishuSchemaState }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date))

  if (!records.length) {
    return (
      <div className="space-y-2">
        {!schemaState.ok && <p className="text-sm text-amber-800">{schemaState.error}</p>}
        <p className="flex items-center gap-2 text-sm text-emerald-700">
          <Check className="size-4" />
          全部记录都已同步到飞书表格
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">
        有 <span className="font-semibold text-primary">{records.length}</span> 条记录还没填进飞书表格。
        一次复制全部，粘贴到「工作台粘贴」视图的最后一行即可。
      </p>
      {!schemaState.ok && <p className="text-sm text-amber-800">{schemaState.error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={async () => {
            if (!schemaState.ok) {
              toast.error(schemaState.error)
              return
            }
            try {
              const res = await fetch("/api/feishu/clipboard", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: sorted.map((r) => r.id) }),
              })
              const data = (await res.json()) as { text?: string; warnings?: string[]; already?: string[]; error?: string }
              if (!res.ok || !data.text) throw new Error(data.error || "复制失败")
              await copy(data.text)
              for (const w of data.warnings ?? []) toast.message(w)
              for (const id of data.already ?? []) toast.message(`本地记录ID ${id} 已粘贴过，请在飞书搜索该 ID，不要新建一行`)
              setCopied(true)
              toast.success(`已复制 ${records.length} 行，粘贴后点「标记为已同步」`)
            } catch (e) {
              toast.error((e as Error).message || "复制失败，请改用导出 CSV")
            }
          }}
        >
          <ClipboardCopy />
          复制 {records.length} 行
        </Button>
        <a
          href="/api/export?scope=unsynced"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium hover:bg-muted"
        >
          <Download className="size-4" />
          导出 CSV
        </a>
        <Button
          variant={copied ? "default" : "outline"}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await fetch("/api/records/mark-synced", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ids: records.map((r) => r.id) }),
            })
            setBusy(false)
            setCopied(false)
            toast.success("已标记为同步")
            router.refresh()
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Check />}
          标记为已同步
        </Button>
      </div>
    </div>
  )
}
