/** Clipboard helpers. Feishu row copy must hand the fetch Promise to ClipboardItem in the click turn. */

export class CopyTextError extends Error {
  text: string
  constructor(message: string, text: string) {
    super(message)
    this.name = "CopyTextError"
    this.text = text
  }
}

function reasonOf(e: unknown): string {
  const err = e as { name?: string; message?: string }
  return `${err?.name ? `${err.name}: ` : ""}${err?.message || String(e)}`
}

/** Text is already in memory (still inside the click). */
export async function copyText(text: string): Promise<void> {
  if (!text) throw new CopyTextError("没有可复制的内容（空字符串）", "")
  const writeText = typeof navigator !== "undefined" ? navigator.clipboard?.writeText : undefined
  if (typeof window !== "undefined" && window.isSecureContext && writeText) {
    try {
      await writeText.call(navigator.clipboard, text)
      return
    } catch (e) {
      throw new CopyTextError(`clipboard.writeText 失败（${reasonOf(e)}）`, text)
    }
  }
  throw new CopyTextError("浏览器不能直接写入剪贴板", text)
}

/**
 * Call synchronously from the click handler.
 * Passes the text Promise to ClipboardItem so the user gesture stays valid across fetch.
 * Returns null when ClipboardItem is unavailable; the caller should show the text for Ctrl+C.
 */
export function copyFetchedText(load: () => Promise<string>): { write: Promise<void> | null; text: Promise<string> } {
  const text = load()
  const blob = text.then((value) => {
    if (!value) throw new Error("没有可复制的内容")
    return new Blob([value], { type: "text/plain" })
  })
  const canWrite =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  if (!canWrite) return { write: null, text }
  const write = navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })])
  return { write, text }
}
