import "server-only"
import fs from "node:fs/promises"
import path from "node:path"
import { resolveKbRoot } from "./feishu-schema-load"
import type { PasteViewSetting } from "./paste-view"

/**
 * T16 private setting: which Feishu view the copied row is built for.
 * Lives in KB_DIR (never in the repo). Stores both the id (used to read, stable
 * across renames) and the name (shown in the UI only).
 */

export function pasteViewConfigPath(kbRoot = resolveKbRoot()): string {
  return path.join(kbRoot, "config", "paste-view.json")
}

function parseSetting(raw: unknown): PasteViewSetting | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const viewId = typeof obj.viewId === "string" ? obj.viewId.trim() : ""
  const viewName = typeof obj.viewName === "string" ? obj.viewName.trim() : ""
  if (!viewId || !viewName) return null
  const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : undefined
  return { viewId, viewName, updatedAt }
}

/** Missing file means "not configured yet" — the copy falls back to the config column order. */
export async function loadPasteViewSetting(kbRoot = resolveKbRoot()): Promise<PasteViewSetting | null> {
  const filePath = pasteViewConfigPath(kbRoot)
  try {
    const text = await fs.readFile(filePath, "utf8")
    return parseSetting(JSON.parse(text) as unknown)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") return null
    return null
  }
}

export async function savePasteViewSetting(
  setting: { viewId: string; viewName: string },
  kbRoot = resolveKbRoot(),
): Promise<PasteViewSetting> {
  const dir = path.join(kbRoot, "config")
  await fs.mkdir(dir, { recursive: true })
  const next: PasteViewSetting = {
    viewId: setting.viewId.trim(),
    viewName: setting.viewName.trim(),
    updatedAt: new Date().toISOString(),
  }
  if (!next.viewId || !next.viewName) throw new Error("视图 id 和名字都不能为空")
  const filePath = pasteViewConfigPath(kbRoot)
  await fs.writeFile(filePath, JSON.stringify(next, null, 2) + "\n", "utf8")
  return next
}
