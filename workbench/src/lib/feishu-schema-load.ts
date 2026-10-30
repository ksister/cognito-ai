import "server-only"
import fs from "node:fs/promises"
import path from "node:path"
import {
  applyFieldIds,
  applyOptionDiff,
  diffColumnOptions,
  diffFieldIds,
  FeishuSchemaError,
  schemaFromJsonText,
  type FeishuSchemaState,
  type FeishuTableSchema,
  type FieldIdChange,
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

type ListedField = { name: string; fieldId?: string; options: string[]; type?: number }

export type FeishuSyncPreview = OptionSyncPreview & {
  path: string
  fieldIds: FieldIdChange[]
  peopleField: FieldIdChange | null
}

export async function previewFeishuOptionSync(
  fields: ListedField[],
  kbRoot = resolveKbRoot(),
): Promise<FeishuSyncPreview> {
  const schema = await readFeishuTableSchema(kbRoot)
  const ids = diffFieldIds(
    schema,
    fields.filter((f): f is ListedField & { fieldId: string } => Boolean(f.fieldId)),
  )
  return {
    ...diffColumnOptions(schema, fields),
    path: feishuTableConfigPath(kbRoot),
    fieldIds: ids.columns,
    peopleField: ids.people,
  }
}

/** Write options and field ids only. Leaves AI rules and defaultOpenId alone. */
export async function writeFeishuOptionSync(
  fields: ListedField[],
  kbRoot = resolveKbRoot(),
): Promise<FeishuSyncPreview> {
  const preview = await previewFeishuOptionSync(fields, kbRoot)
  if (!preview.changes.length && !preview.fieldIds.length && !preview.peopleField) return preview
  const raw = JSON.parse(await fs.readFile(preview.path, "utf8")) as unknown
  const withOptions = applyOptionDiff(raw, preview.changes)
  const next = applyFieldIds(withOptions, preview.fieldIds, preview.peopleField)
  await fs.writeFile(preview.path, JSON.stringify(next, null, 2) + "\n", "utf8")
  return preview
}
