"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { parseCompanyPrefixes, parseNicknames } from "@/lib/replay-model"

/**
 * 设置页「发言人」分组：我的昵称 + 我方公司名前缀。
 * 存 KB_DIR/config/speakers.json（不进仓库）；主流程转写和回放共用。
 */
export function SpeakersEditor({
  initialNicknames,
  initialPrefixes,
  fromLegacy,
}: {
  initialNicknames: string[]
  initialPrefixes: string[]
  /** 昵称是从旧配置 config/replay.json 读来的（还没保存过新文件）。 */
  fromLegacy: boolean
}) {
  const [nickText, setNickText] = useState(initialNicknames.join("、"))
  const [prefixText, setPrefixText] = useState(initialPrefixes.join("、"))
  const [saved, setSaved] = useState({ nicknames: initialNicknames, prefixes: initialPrefixes })
  const [busy, setBusy] = useState(false)
  const nickPreview = parseNicknames(nickText)
  const prefixPreview = parseCompanyPrefixes(prefixText)

  async function save() {
    setBusy(true)
    try {
      const res = await fetch("/api/replay/speakers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ myNicknames: nickText, companyPrefixes: prefixText }),
      })
      const data = (await res.json()) as {
        ok?: boolean
        myNicknames?: string[]
        companyPrefixes?: string[]
        error?: string
      }
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? `保存失败（HTTP ${res.status}）`)
        return
      }
      setSaved({ nicknames: data.myNicknames ?? [], prefixes: data.companyPrefixes ?? [] })
      toast.success("已保存到 config/speakers.json")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {fromLegacy && (
        <p className="text-xs text-amber-700">
          昵称目前是从旧配置 config/replay.json 读的；点保存后会写到新的 config/speakers.json，旧文件不动。
        </p>
      )}

      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="speakers-nicknames">
          我的昵称
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            id="speakers-nicknames"
            value={nickText}
            onChange={(e) => setNickText(e.target.value)}
            placeholder="例如：张三、小张（逗号或顿号分隔，可填多个）"
            className="bg-background"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>会存成：</span>
          {nickPreview.length === 0 ? (
            <span>（空，判断发言人时只能按气泡左右）</span>
          ) : (
            nickPreview.map((name) => (
              <Badge key={name} variant="secondary">
                {name}
              </Badge>
            ))
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor="speakers-prefixes">
          我方公司名前缀
        </label>
        <Input
          id="speakers-prefixes"
          value={prefixText}
          onChange={(e) => setPrefixText(e.target.value)}
          placeholder="例如：某公司（微信里显示成「某公司_张三」时用）"
          className="bg-background"
        />
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>会存成：</span>
          {prefixPreview.length === 0 ? (
            <span>（空，昵称会原样比较）</span>
          ) : (
            prefixPreview.map((name) => (
              <Badge key={name} variant="secondary">
                {name}
              </Badge>
            ))
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          只用于匹配发言人（「某公司_张三」和「张三」当同一个人），不会改写转写原文。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-60"
        >
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          保存
        </button>
        <span className="text-xs text-muted-foreground">
          已保存：昵称 {saved.nicknames.length} 个 · 公司前缀 {saved.prefixes.length} 个（只写本机 KB_DIR，不进仓库）
        </span>
      </div>
    </div>
  )
}
