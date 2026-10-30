const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

/** `<聊天日期>-<标题前 20 字>` with illegal filename characters replaced by `-`. */
export function screenshotStem(date: string, title: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "未命名"
  const chars = Array.from((title || "").trim())
  const head = (chars.slice(0, 20).join("") || "未命名").replace(ILLEGAL, "-").replace(/^\.+/, "") || "未命名"
  return `${day}-${head}`
}

/**
 * Next free names `<stem>-<n>.jpg`. Colliding n is skipped.
 * Existing `截图-YYYYMMDD-N.jpg` files are left untouched; they only occupy a name if it matches.
 */
export function allocateScreenshotNames(taken: Iterable<string>, date: string, title: string, count: number): string[] {
  const used = new Set(taken)
  const stem = screenshotStem(date, title)
  const out: string[] = []
  let n = 1
  for (let i = 0; i < count; i++) {
    let name = `${stem}-${n}.jpg`
    while (used.has(name)) {
      n += 1
      name = `${stem}-${n}.jpg`
    }
    used.add(name)
    out.push(name)
    n += 1
  }
  return out
}

export function unlinkedFileNames(files: string[], linked: Iterable<string>): string[] {
  const used = new Set(linked)
  return files.filter((name) => !used.has(name))
}
