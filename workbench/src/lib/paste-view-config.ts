import "server-only"
import fs from "node:fs/promises"
import path from "node:path"
import { resolveKbRoot } from "./feishu-schema-load"
import { parsePasteViewConfigText, type PasteViewSetting } from "./paste-view"

/**
 * T16 private setting: which Feishu view the copied row is built for.
 * Lives in KB_DIR (never in the repo). Stores the id (used to read, stable
 * across renames), the name (shown in the UI only), and the last successfully
 * read column order (fallback when lark-cli cannot read the view).
 */

export function pasteViewConfigPath(kbRoot = resolveKbRoot()): string {
  return path.join(kbRoot, "config", "paste-view.json")
}

export type PasteViewConfigState =
  | { ok: true; setting: PasteViewSetting | null }
  | { ok: false; error: string }

/**
 * Missing file means "not configured yet" (copy falls back to the config column
 * order). A file that exists but cannot be parsed is reported as broken — the
 * settings page must ask the user to pick the view again instead of silently
 * pretending nothing is configured.
 */
export async function loadPasteViewConfig(kbRoot = resolveKbRoot()): Promise<PasteViewConfigState> {
  const filePath = pasteViewConfigPath(kbRoot)
  let text: string
  try {
    text = await fs.readFile(filePath, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, setting: null }
    return { ok: false, error: `配置文件读不了：${(e as Error).message}` }
  }
  return parsePasteViewConfigText(text)
}

async function writeSetting(setting: PasteViewSetting, kbRoot: string): Promise<PasteViewSetting> {
  await fs.mkdir(path.join(kbRoot, "config"), { recursive: true })
  await fs.writeFile(pasteViewConfigPath(kbRoot), JSON.stringify(setting, null, 2) + "\n", "utf8")
  return setting
}

export async function savePasteViewSetting(
  input: { viewId: string; viewName: string; columns?: string[] },
  kbRoot = resolveKbRoot(),
): Promise<PasteViewSetting> {
  const viewId = input.viewId.trim()
  const viewName = input.viewName.trim()
  if (!viewId || !viewName) throw new Error("视图 id 和名字都不能为空")
  const columns = (input.columns ?? []).map((c) => c.trim()).filter(Boolean)
  const next: PasteViewSetting = {
    viewId,
    viewName,
    updatedAt: new Date().toISOString(),
  }
  if (columns.length) {
    next.columns = columns
    next.columnsReadAt = new Date().toLocaleDateString("sv-SE")
  }
  return writeSetting(next, kbRoot)
}

/**
 * Remember the column order that was just read successfully. Failures are
 * ignored on purpose: the cache is an optimisation, never a reason to fail a copy.
 */
export async function cacheViewColumns(columns: string[], kbRoot = resolveKbRoot()): Promise<void> {
  const list = columns.map((c) => c.trim()).filter(Boolean)
  if (!list.length) return
  const state = await loadPasteViewConfig(kbRoot)
  if (!state.ok || !state.setting) return
  try {
    await writeSetting(
      { ...state.setting, columns: list, columnsReadAt: new Date().toLocaleDateString("sv-SE") },
      kbRoot,
    )
  } catch {
    /* cache is best effort */
  }
}
