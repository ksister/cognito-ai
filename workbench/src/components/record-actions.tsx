"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, ClipboardCopy, Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { selectClass } from "@/components/bits"
import { toTsvRows } from "@/lib/feishu"
import { STATUSES, type Status, type SupportRecord } from "@/lib/types"

function apiPath(r: SupportRecord) {
  return `/api/records/${encodeURIComponent(r.customer)}/${encodeURIComponent(r.file.replace(/\.md$/, ""))}`
}

export function StatusSelect({ record }: { record: SupportRecord }) {
  const router = useRouter()
  const [value, setValue] = useState<Status>(record.status)
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
          router.refresh()
        } else toast.error("更新失败")
      }}
    >
      {STATUSES.map((s) => (
        <option key={s}>{s}</option>
      ))}
    </select>
  )
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text)
}

export function CopyFeishuButton({ record }: { record: SupportRecord }) {
  const router = useRouter()
  return (
    <Button
      variant="outline"
      onClick={async () => {
        try {
          await copy(toTsvRows([record]))
          await fetch("/api/records/mark-synced", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: [record.id] }),
          })
          toast.success("已复制，去飞书表格选中一行的第一个单元格粘贴即可")
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

export function SyncPanel({ records }: { records: SupportRecord[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date))

  if (!records.length) {
    return (
      <p className="flex items-center gap-2 text-sm text-emerald-700">
        <Check className="size-4" />
        全部记录都已同步到飞书表格
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">
        有 <span className="font-semibold text-primary">{records.length}</span> 条记录还没填进飞书表格。
        一次复制全部，粘贴到表格最后一行即可。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={async () => {
            try {
              await copy(toTsvRows(sorted))
              setCopied(true)
              toast.success(`已复制 ${records.length} 行，粘贴后点「标记为已同步」`)
            } catch {
              toast.error("复制失败，请改用导出 CSV")
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
