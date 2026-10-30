/** Clipboard write that still works after an awaited fetch has used up the click gesture. */

export class CopyTextError extends Error {
  /** Full text the caller can show in a selectable box. */
  text: string
  constructor(message: string, text: string) {
    super(message)
    this.name = "CopyTextError"
    this.text = text
  }
}

function clipboardError(e: unknown): string {
  const err = e as { name?: string; message?: string }
  const name = err?.name ? `${err.name}: ` : ""
  return `${name}${err?.message || String(e)}`
}

function copyWithTextarea(text: string): void {
  if (typeof document === "undefined") throw new Error("没有 document，无法使用 execCommand")
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  ta.style.position = "fixed"
  ta.style.top = "0"
  ta.style.left = "0"
  ta.style.width = "2em"
  ta.style.height = "2em"
  ta.style.padding = "0"
  ta.style.border = "none"
  ta.style.outline = "none"
  ta.style.boxShadow = "none"
  ta.style.background = "transparent"
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  let reason = "document.execCommand('copy') 返回 false"
  try {
    ok = document.execCommand("copy")
  } catch (e) {
    reason = clipboardError(e)
    ok = false
  } finally {
    document.body.removeChild(ta)
  }
  if (!ok) throw new Error(reason)
}

/**
 * Write text to the clipboard.
 * 1. navigator.clipboard.writeText
 * 2. hidden textarea + execCommand('copy')
 * Throws CopyTextError with the original text so the UI can show a selectable preview.
 */
export async function copyText(text: string): Promise<void> {
  if (!text) throw new CopyTextError("没有可复制的内容（空字符串）", "")
  const reasons: string[] = []
  const secure = typeof window !== "undefined" && window.isSecureContext
  const writeText = typeof navigator !== "undefined" ? navigator.clipboard?.writeText : undefined
  if (!secure) reasons.push("当前页面不是安全上下文（需要 https 或 localhost）")
  if (writeText && secure) {
    try {
      await writeText.call(navigator.clipboard, text)
      return
    } catch (e) {
      reasons.push(`clipboard.writeText 失败（${clipboardError(e)}）`)
    }
  } else if (secure) {
    reasons.push("浏览器没有 clipboard.writeText")
  }
  try {
    copyWithTextarea(text)
    return
  } catch (e) {
    reasons.push(`execCommand('copy') 失败（${clipboardError(e)}）`)
  }
  throw new CopyTextError(reasons.join("；"), text)
}

/**
 * Call this synchronously inside the click handler, before any await.
 * ClipboardItem keeps the user activation alive across the fetch on Chromium.
 * If that path fails, falls back to copyText.
 */
export function copyWhenReady(load: () => Promise<string>): Promise<void> {
  const pending = load()
  let reserved: Promise<void> | null = null
  const canReserve =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  if (canReserve) {
    try {
      const item = new ClipboardItem({
        "text/plain": pending.then((text) => {
          if (!text) throw new Error("没有可复制的内容")
          return new Blob([text], { type: "text/plain" })
        }),
      })
      reserved = navigator.clipboard.write([item])
    } catch {
      reserved = null
    }
  }
  return (async () => {
    let text: string
    try {
      text = await pending
    } catch (e) {
      void reserved?.catch(() => {})
      throw e
    }
    if (reserved) {
      try {
        await reserved
        return
      } catch {
        /* gesture reservation failed; try writeText / execCommand */
      }
    }
    await copyText(text)
  })()
}
