"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { parseNicknames } from "@/lib/replay-model"

/**
 * 设置页「我的昵称」：可填多个，存 KB_DIR/config/replay.json（不进仓库）。
 * T27 判断发言人、T29 取「我当时的实际回复」都用它。
 */
export function NicknameEditor({ initial }: { initial: string[] }) {
  const [text, setText] = useState(initial.join("、"))
  const [saved, setSaved] = useState<string[]>(initial)
  const [busy, setBusy] = useState(false)
  const preview = parseNicknames(text)

  async function save() {
    setBusy(true)
    try {
      const res = await fetch("/api/replay/nicknames", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ myNicknames: text }),
      })
      const data = (await res.json()) as { ok?: boolean; myNicknames?: string[]; error?: string }
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? `保存失败（HTTP ${res.status}）`)
        return
      }
      setSaved(data.myNicknames ?? [])
      toast.success(data.myNicknames?.length ? `已保存 ${data.myNicknames.length} 个昵称` : "已清空昵称")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="例如：张三、小张、张工（逗号或顿号分隔，可填多个）"
          className="bg-background"
          aria-label="我的昵称"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-60"
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          保存
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>会存成：</span>
        {preview.length === 0 ? (
          <span>（空，T27 判断发言人时会退回按气泡位置判断）</span>
        ) : (
          preview.map((name) => (
            <Badge key={name} variant="secondary">
              {name}
            </Badge>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        已保存：{saved.length ? saved.join("、") : "（空）"}。只写入本机 KB_DIR 的 config/replay.json，不进仓库。
      </p>
    </div>
  )
}
