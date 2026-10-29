"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Loader2, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"

export function AnalyzeButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true)
        try {
          const res = await fetch("/api/requirements/analyze", { method: "POST" })
          const data = await res.json()
          if (!res.ok) throw new Error(data.error)
          if (data.warning) toast.warning(data.warning)
          toast.success(`需求分析已生成：requirements/${data.file}`)
          router.push(`/requirements?doc=${encodeURIComponent(data.file)}`)
          router.refresh()
        } catch (e) {
          toast.error(`生成失败：${(e as Error).message}`)
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
      {busy ? "分析中…" : "生成需求分析"}
    </Button>
  )
}
