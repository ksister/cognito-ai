import "server-only"
import fs from "node:fs/promises"
import path from "node:path"
import {
  applyOptionDiff,
  diffColumnOptions,
  FeishuSchemaError,
  schemaFromJsonText,
  type FeishuSchemaState,
  type FeishuTableSchema,
  type OptionSyncPreview,
} from "./feishu-schema"

/** Same resolution as `KB_ROOT` in kb.ts. Do not import kb.ts here (it freezes the root at load). */
export function resolveKbRoot(): string {
  return path.resolve(process.env.KB_DIR ?? path.join(process.cwd(), ".."))
}

/** Real table config stays outside the public repo. */
export function feishuTableConfigPath(kbRoot = resolveKbRoot()): string {
  return path.join(kbRoot, "config", "feishu-table.json")
}

export async function loadFeishuSchemaState(kbRoot = resolveKbRoot()): Promise<FeishuSchemaState> {
  const filePath = feishuTableConfigPath(kbRoot)
  try {
    let text: string | null
    try {
      text = await fs.readFile(filePath, "utf8")
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== "ENOENT") {
        return {
          ok: false,
          path: filePath,
          error: `无法读取飞书表结构配置：${filePath}。${(e as Error).message}`,
        }
      }
      text = null
    }
    return { ok: true, schema: schemaFromJsonText(text, filePath), path: filePath }
  } catch (e) {
    const message =
      e instanceof FeishuSchemaError
        ? e.message
        : `飞书表结构配置读取失败：${filePath}。${(e as Error).message}`
    return { ok: false, error: message, path: filePath }
  }
}

export async function readFeishuTableSchema(kbRoot = resolveKbRoot()): Promise<FeishuTableSchema> {
  const state = await loadFeishuSchemaState(kbRoot)
  if (!state.ok) throw new FeishuSchemaError(state.error)
  return state.schema
}

export async function previewFeishuOptionSync(
  fields: { name: string; options: string[] }[],
  kbRoot = resolveKbRoot(),
): Promise<OptionSyncPreview & { path: string }> {
  const schema = await readFeishuTableSchema(kbRoot)
  return { ...diffColumnOptions(schema, fields), path: feishuTableConfigPath(kbRoot) }
}

/** Write only `options` for columns whose names match the preview. */
export async function writeFeishuOptionSync(
  fields: { name: string; options: string[] }[],
  kbRoot = resolveKbRoot(),
): Promise<OptionSyncPreview & { path: string }> {
  const filePath = feishuTableConfigPath(kbRoot)
  const schema = await readFeishuTableSchema(kbRoot)
  const preview = diffColumnOptions(schema, fields)
  if (!preview.changes.length) return { ...preview, path: filePath }
  const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown
  const next = applyOptionDiff(raw, preview.changes)
  await fs.writeFile(filePath, JSON.stringify(next, null, 2) + "\n", "utf8")
  return { ...preview, path: filePath }
}
