"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, ClipboardCopy, Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { selectClass } from "@/components/bits"
import { CopyFallback } from "@/components/copy-fallback"
import { copyFetchedText } from "@/lib/copy-text"
import type { FeishuSchemaState } from "@/lib/feishu-schema"
import { feishuFailureMessage, feishuOutcomeMessage } from "@/lib/lark-push-plan"
import { STATUSES, type FeishuPushResult, type Status, type SupportRecord } from "@/lib/types"

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
          if (record.feishuRecordId) {
            toast.message(`点「同步飞书」会更新同一行 ${record.feishuRecordId}，不会新建`)
          } else if (record.local_id) {
            toast.message(`请在飞书搜索 ${record.local_id}，修改同一行，不要新建`)
          }
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

function startRowCopy(
  ids: string[],
  onOk: (payload: ClipPayload) => void,
  onFail: (kind: "api" | "clipboard", message: string, text?: string) => void,
) {
  const box: { payload?: ClipPayload } = {}
  const { write, text } = copyFetchedText(async () => {
    const payload = await fetchClipboard(ids)
    box.payload = payload
    return payload.text
  })
  const showForManualCopy = (message: string) => {
    void text
      .then((value) => onFail("clipboard", message, value))
      .catch((e: unknown) => onFail("api", (e as Error).message))
  }
  if (!write) {
    showForManualCopy("当前浏览器不支持 ClipboardItem。下方文本已全选，请按 Ctrl 或 Cmd + C")
    return
  }
  void write
    .then(() => {
      if (box.payload) onOk(box.payload)
    })
    .catch((e: unknown) => showForManualCopy((e as Error).message || "ClipboardItem 写入失败"))
}

export function SyncFeishuButton({ record }: { record: SupportRecord }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const res = await fetch(apiPath(record), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ syncFeishu: true }),
          })
          const data = (await res.json()) as SupportRecord & { error?: string; feishu?: FeishuPushResult }
          if (!res.ok) {
            toast.error(data.error || "同步失败")
            return
          }
          const fr = data.feishu
          if (!fr) {
            toast.error("没有飞书结果")
            return
          }
          for (const warning of fr.warnings ?? []) toast.message(warning)
          if (fr.ok) toast.success(feishuOutcomeMessage(fr.action, fr.recordId))
          else toast.error(feishuFailureMessage(fr))
          router.refresh()
        } catch (e) {
          toast.error((e as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : null}
      同步飞书
    </Button>
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
          startRowCopy(
            [record.id],
            (payload) => {
              for (const w of payload.warnings ?? []) toast.message(w)
              for (const id of payload.already ?? []) toast.message(`本地记录ID ${id} 已粘贴过，请在飞书搜索该 ID，不要新建一行`)
              void fetch("/api/records/mark-synced", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: [record.id] }),
              }).then((marked) => {
                if (!marked.ok) toast.message("已复制，但标记已同步失败，可稍后在首页再标")
              })
              toast.success("已复制到剪贴板。到飞书「工作台粘贴」视图，选中一行的第一个单元格粘贴")
              router.refresh()
            },
            (kind, message, value) => {
              if (kind === "clipboard" && value) setFallback(value)
              toast.error(kind === "api" ? `没有复制：接口失败。${message}` : `没有复制到剪贴板。${message}`)
            },
          )
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
            startRowCopy(
              sorted.map((r) => r.id),
              (payload) => {
                for (const w of payload.warnings ?? []) toast.message(w)
                for (const id of payload.already ?? []) toast.message(`本地记录ID ${id} 已粘贴过，请在飞书搜索该 ID，不要新建一行`)
                setCopied(true)
                toast.success(`已复制 ${records.length} 行到剪贴板。粘贴后点「标记为已同步」`)
              },
              (kind, message, value) => {
                setCopied(false)
                if (kind === "clipboard" && value) setFallback(value)
                toast.error(kind === "api" ? `没有复制：接口失败。${message}` : `没有复制到剪贴板。${message}`)
              },
            )
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
