"use client"

import { useEffect, useRef } from "react"

/** Last-resort box when both clipboard APIs fail. Focus selects the whole TSV. */
export function CopyFallback({ text }: { text: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [text])
  return (
    <div className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-2">
      <p className="text-xs text-amber-950">剪贴板没有写上。下面是要复制的内容，已全选，按 Ctrl 或 Cmd + C。</p>
      <textarea
        ref={ref}
        readOnly
        value={text}
        rows={4}
        className="w-full resize-y rounded-md border bg-background p-2 font-mono text-xs"
        onFocus={(e) => e.currentTarget.select()}
      />
    </div>
  )
}
