import "server-only"
import path from "node:path"
import { KB_ROOT, safeName, updateRecord } from "./kb"
import { pushRecordToFeishu, type LarkPushResult } from "./lark-bitable"
import { feishuSyncPatchFromPush } from "./lark-push-plan"
import type { SupportRecord } from "./types"

/**
 * Push one already-saved local record.
 * A stored feishu_record_id updates that Feishu row; otherwise this creates one
 * and writes the id back. Local files are never rolled back.
 */
export async function pushSavedRecord(
  rec: SupportRecord,
  opts?: { companyOption?: string; handlerOpenIds?: string[] },
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
