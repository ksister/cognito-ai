"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, ClipboardCopy, Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { selectClass } from "@/components/bits"
import { CopyFallback } from "@/components/copy-fallback"
import { CopyTextError, copyWhenReady } from "@/lib/copy-text"
import type { FeishuSchemaState } from "@/lib/feishu-schema"
import { STATUSES, type Status, type SupportRecord } from "@/lib/types"

type ClipPayload = { text: string; warnings?: string[]; already?: string[]; error?: string }

async function fetchClipboard(ids: string[]): Promise<ClipPayload> {
  let res: Response
  try {
    res = await fetch("/api/feishu/clipboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    })
  } catch (e) {
    throw new Error(`网络错误：${(e as Error).message}`)
  }
  let data: ClipPayload
  try {
    data = (await res.json()) as ClipPayload
  } catch {
    throw new Error(`接口返回不是 JSON（HTTP ${res.status}）`)
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  if (!data.text) throw new Error(data.error || "接口返回了空内容")
  return data
}

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

export function CopyFeishuButton({ record, schemaState }: { record: SupportRecord; schemaState: FeishuSchemaState }) {
  const router = useRouter()
  const [fallback, setFallback] = useState<string | null>(null)
  return (
    <div className="flex flex-col items-stretch gap-2">
      <Button
        variant="outline"
        onClick={() => {
          if (!schemaState.ok) {
            toast.error(`没有复制：表结构配置不可用。${schemaState.error}`)
            return
          }
          setFallback(null)
          let payload: ClipPayload | null = null
          const job = copyWhenReady(async () => {
            payload = await fetchClipboard([record.id])
            return payload.text
          })
          void job
            .then(async () => {
              if (!payload) return
              for (const w of payload.warnings ?? []) toast.message(w)
              for (const id of payload.already ?? []) toast.message(`本地记录ID ${id} 已粘贴过，请在飞书搜索该 ID，不要新建一行`)
              const marked = await fetch("/api/records/mark-synced", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: [record.id] }),
              })
              if (!marked.ok) toast.message("已复制，但标记已同步失败，可稍后在首页再标")
              toast.success("已复制到剪贴板。到飞书「工作台粘贴」视图，选中一行的第一个单元格粘贴")
              router.refresh()
            })
            .catch((e: unknown) => {
              if (e instanceof CopyTextError) {
                if (e.text) setFallback(e.text)
                toast.error(`没有复制到剪贴板。${e.message}`)
                return
              }
              toast.error(`没有复制：接口失败。${(e as Error).message}`)
            })
        }}
      >
        <ClipboardCopy />
        复制为飞书行
      </Button>
      {fallback && <CopyFallback text={fallback} />}
    </div>
  )
}

export function SyncPanel({ records, schemaState }: { records: SupportRecord[]; schemaState: FeishuSchemaState }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [fallback, setFallback] = useState<string | null>(null)
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
          onClick={() => {
            if (!schemaState.ok) {
              toast.error(`没有复制：表结构配置不可用。${schemaState.error}`)
              return
            }
            setFallback(null)
            let payload: ClipPayload | null = null
            const job = copyWhenReady(async () => {
              payload = await fetchClipboard(sorted.map((r) => r.id))
              return payload.text
            })
            void job
              .then(() => {
                if (!payload) return
                for (const w of payload.warnings ?? []) toast.message(w)
                for (const id of payload.already ?? []) toast.message(`本地记录ID ${id} 已粘贴过，请在飞书搜索该 ID，不要新建一行`)
                setCopied(true)
                toast.success(`已复制 ${records.length} 行到剪贴板。粘贴后点「标记为已同步」`)
              })
              .catch((e: unknown) => {
                setCopied(false)
                if (e instanceof CopyTextError) {
                  if (e.text) setFallback(e.text)
                  toast.error(`没有复制到剪贴板。${e.message}`)
                  return
                }
                toast.error(`没有复制：接口失败。${(e as Error).message}`)
              })
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
      {fallback && <CopyFallback text={fallback} />}
    </div>
  )
}
