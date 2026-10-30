/**
 * Pure decisions for Feishu create vs update.
 * No CLI, no secrets, no real field ids.
 *
 * Attachment default: upload only screenshot filenames that are not already
 * listed as attached. Never send the attachment column in the field payload,
 * so an update does not clear files already on the Feishu row.
 */

export const RECORD_NOT_READY_CODE = "800030405"
/** Wait before retrying the first update. Immediate upsert can return not_found. */
export const RECORD_NOT_READY_DELAY_MS = 1500

export type FeishuWriteAction = "create" | "update"

export function pushActionFor(recordId: string | undefined | null): FeishuWriteAction {
  return recordId?.trim() ? "update" : "create"
}

/** Filenames still to upload. Order follows `current`. Duplicates are dropped. */
export function screenshotsToUpload(
  current: readonly string[],
  alreadyAttached: readonly string[] | undefined,
): string[] {
  const done = new Set((alreadyAttached ?? []).map((name) => name.trim()).filter(Boolean))
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of current) {
    const trimmed = name.trim()
    if (!trimmed || done.has(trimmed) || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

export function isRecordNotReady(code: string | number | undefined, message?: string): boolean {
  return `${code ?? ""}\n${message ?? ""}`.includes(RECORD_NOT_READY_CODE)
}

/** Read a record id from lark-cli JSON. Upsert lives at data.record.record_id_list[0]. */
export function extractCliRecordId(json: Record<string, unknown> | null | undefined): string | undefined {
  if (!json) return undefined
  const data = (
    json.data && typeof json.data === "object" ? json.data : json
  ) as Record<string, unknown>
  if (typeof data.record_id === "string" && data.record_id) return data.record_id
  const record = data.record
  if (record && typeof record === "object") {
    const rec = record as Record<string, unknown>
    if (typeof rec.record_id === "string" && rec.record_id) return rec.record_id
    if (Array.isArray(rec.record_id_list) && rec.record_id_list[0]) return String(rec.record_id_list[0])
  }
  const list = data.record_id_list ?? json.record_id_list
  if (Array.isArray(list) && list[0]) return String(list[0])
  const records = (data.records ?? data.items ?? json.records) as { record_id?: string }[] | undefined
  if (Array.isArray(records) && records[0]?.record_id) return String(records[0].record_id)
  if (typeof json.record_id === "string" && json.record_id) return json.record_id
  return undefined
}

/**
 * Reject an update that created a different row.
 * Returns null when the response is the same row, or when the CLI gave no id to compare.
 */
export function sameRowUpdateError(
  json: Record<string, unknown> | null | undefined,
  expectedId: string,
): string | null {
  const expected = expectedId.trim()
  if (!expected) return "缺少要更新的 feishu_record_id"
  if (!json) return null
  if (json.created === true) return "更新请求却创建了新行，已中止，本地仍指向原来的行号"
  if (json.updated === false) return "飞书返回 updated=false，这一行没有改到"
  const id = extractCliRecordId(json)
  if (id && id !== expected) return "更新返回了另一个 record_id，已中止以免改去指向第二行"
  return null
}

export function omitAttachmentFields(
  fields: Record<string, unknown>,
  attachmentFieldIds: readonly string[],
): Record<string, unknown> {
  const safe = { ...fields }
  for (const id of attachmentFieldIds) {
    if (id) delete safe[id]
  }
  return safe
}

/**
 * lark-cli `--file` must be a relative path under the process cwd.
 * Returns null when the caller should copy the file under cwd first.
 */
export function cliRelativeFile(cwd: string, filePath: string): string | null {
  const posix = (p: string) => p.replace(/\\/g, "/")
  const root = posix(cwd).replace(/\/+$/, "")
  const file = posix(filePath)
  let rel: string
  if (root && file.startsWith(`${root}/`)) rel = file.slice(root.length + 1)
  else if (!file.startsWith("/") && !/^[A-Za-z]:\//.test(file)) rel = file
  else return null
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return null
  return rel
}

export function feishuOutcomeMessage(action: "created" | "updated" | undefined, recordId?: string): string {
  const id = recordId?.trim()
  if (action === "updated") {
    return id ? `已更新同一飞书行 ${id}，没有新建第二行` : "已更新同一飞书行，没有新建第二行"
  }
  return id ? `已新建飞书行 ${id}` : "已新建飞书行"
}

export function feishuFailureMessage(result: {
  action?: "created" | "updated"
  error?: string
  recordId?: string
  steps?: { ok: boolean; step: string }[]
}): string {
  const stepFail = (result.steps ?? []).filter((step) => !step.ok).map((step) => step.step).join(",") || "未知"
  const reason = result.error || "失败"
  if (result.action === "updated") {
    return `本地已保存；飞书更新未完成（${stepFail}）：${reason}。没有新建第二行。`
  }
  if (result.recordId?.trim()) {
    return `本地已保存；飞书未完成（${stepFail}）：${reason}。行号已记下，再次同步会更新这一行。`
  }
  return `本地已保存；飞书未完成（${stepFail}）：${reason}。可用「复制为飞书行」降级`
}

export type FeishuSyncPatch = {
  feishuSynced?: boolean
  feishuRecordId?: string
  feishuSyncedAt?: string
  feishuAttached?: string[]
}

/** What to write into local frontmatter after a push. No record id → write nothing. */
export function feishuSyncPatchFromPush(
  result: { ok: boolean; recordId?: string; attachedNames?: string[] },
  previousAttached: readonly string[] | undefined,
  syncedAt: string,
): FeishuSyncPatch | null {
  const recordId = result.recordId?.trim()
  if (!recordId) return null
  const attached = [...(previousAttached ?? [])]
  for (const name of result.attachedNames ?? []) {
    const trimmed = name.trim()
    if (trimmed && !attached.includes(trimmed)) attached.push(trimmed)
  }
  const patch: FeishuSyncPatch = {
    feishuRecordId: recordId,
    feishuSynced: result.ok,
  }
  if (result.ok) patch.feishuSyncedAt = syncedAt
  if (attached.length) patch.feishuAttached = attached
  return patch
}
