import "server-only"
import path from "node:path"
import { getRecord, KB_ROOT, safeName, updateRecord } from "./kb"
import { enqueueFeishuWrite, recordKey, setFeishuJob } from "./feishu-jobs"
import { pushRecordToFeishu, type LarkPushResult } from "./lark-bitable"
import { feishuSyncPatchFromPush } from "./lark-push-plan"
import type { SupportRecord } from "./types"

export type PushSavedRecordOptions = { companyOption?: string; handlerOpenIds?: string[] }

/**
 * Push one already-saved local record.
 * A stored feishu_record_id updates that Feishu row; otherwise this creates one
 * and writes the id back. Local files are never rolled back.
 */
export async function pushSavedRecord(
  rec: SupportRecord,
  opts?: PushSavedRecordOptions,
): Promise<{ record: SupportRecord; feishu: LarkPushResult }> {
  const filesDir = path.join(KB_ROOT, "customers", safeName(rec.customer), "files")
  const feishu = await pushRecordToFeishu({
    draft: { ...rec },
    companyOption: opts?.companyOption,
    handlerOpenIds: opts?.handlerOpenIds,
    feishuRecordId: rec.feishuRecordId,
    attachedNames: rec.feishuAttached,
    screenshotFiles: (rec.screenshots ?? []).map((name) => ({
      name,
      path: path.join(filesDir, name),
    })),
  })
  const patch = feishuSyncPatchFromPush(feishu, rec.feishuAttached, new Date().toISOString())
  if (!patch) return { record: rec, feishu }
  const record = await updateRecord(rec.customer, rec.file.replace(/\.md$/, ""), patch)
  return { record, feishu }
}

/**
 * Queue one Feishu write for a record (T11 review 1) and keep the write status
 * (`writing` / `written` / `failed`) that the status route and the desktop exit
 * logic read.
 *
 * The record is re-read from disk INSIDE the lock: while this task waited, an
 * earlier write may have written `feishu_record_id` back, and this write must
 * update that row instead of creating a second one.
 */
export function queueSavedRecordPush(
  customer: string,
  file: string,
  opts?: PushSavedRecordOptions,
): Promise<{ record: SupportRecord; feishu: LarkPushResult }> {
  const key = recordKey(customer, file)
  return enqueueFeishuWrite(key, async () => {
    setFeishuJob(key, "writing")
    try {
      const fresh = await getRecord(customer, file.replace(/\.md$/, ""))
      if (!fresh) throw new Error("记录不存在")
      const pushed = await pushSavedRecord(fresh, opts)
      setFeishuJob(key, pushed.feishu.ok ? "written" : "failed", pushed.feishu)
      return pushed
    } catch (e) {
      setFeishuJob(key, "failed", { ok: false, steps: [], warnings: [], error: String(e) })
      throw e
    }
  })
}
