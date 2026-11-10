import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RecordDraft } from "./types"

/**
 * T11 review 1: two writes for the same record must produce exactly ONE Feishu row.
 * The Feishu side is mocked here; the local store is the real kb.ts in a temp dir, so the
 * `feishu_record_id` write-back and the re-read inside the lock are exercised for real.
 */
const state = vi.hoisted(() => ({
  rows: 0,
  calls: [] as ("create" | "update")[],
  /** The `status` of every record the Feishu side was asked to write. */
  statuses: [] as string[],
  /** When true the first create resolves slowly, like a real lark-cli call. */
  slowFirst: true,
}))

vi.mock("./lark-bitable", () => ({
  pushRecordToFeishu: async (input: { feishuRecordId?: string; draft?: { status?: string } }) => {
    state.statuses.push(String(input.draft?.status ?? ""))
    const existing = input.feishuRecordId?.trim()
    if (existing) {
      state.calls.push("update")
      return {
        ok: true,
        action: "updated" as const,
        recordId: existing,
        steps: [{ step: "update", ok: true }],
        warnings: [],
        mode: "cli" as const,
      }
    }
    if (state.slowFirst) await new Promise((r) => setTimeout(r, 20))
    state.rows += 1
    state.calls.push("create")
    return {
      ok: true,
      action: "created" as const,
      recordId: `rec${state.rows}`,
      attachedNames: [],
      steps: [{ step: "create", ok: true }],
      warnings: [],
      mode: "cli" as const,
    }
  },
}))

const kbDir = mkdtempSync(path.join(os.tmpdir(), "feishu-queue-push-"))
process.env.KB_DIR = kbDir

const { createRecord, getRecord, updateRecord } = await import("./kb")
const { queueSavedRecordPush } = await import("./feishu-record-push")

function draft(over: Partial<RecordDraft> = {}): RecordDraft {
  return {
    title: "极耳定位偏移",
    date: "2026-11-10",
    customer: "示例客户",
    channel: "微信",
    contact: "张工",
    product: "",
    module: "",
    category: "",
    status: "跟进中",
    problem: "极耳定位偏 0.3mm",
    process: "",
    solution: "",
    thoughts: "",
    needs: [],
    uncertain: [],
    chat: "",
    screenshots: [],
    site: "",
    support_type: "",
    resolution: "",
    fixed_version: "",
    dimensions: [],
    inspection_types: [],
    industries: [],
    case_visibility: "",
    docs: "",
    local_id: "",
    extras: {},
    ...over,
  }
}

describe("queueSavedRecordPush", () => {
  beforeEach(() => {
    state.rows = 0
    state.calls = []
    state.statuses = []
    state.slowFirst = true
  })

  it("saving and immediately changing the status still creates only one row", async () => {
    const created = await createRecord(draft())
    const noExt = created.file.replace(/\.md$/, "")
    // 「保存后马上改状态再保存」: the status is changed and pushed while the first
    // background write is still running, so it has no feishu_record_id on disk yet.
    const edited = await updateRecord(created.customer, noExt, { status: "已解决" })
    const [first, second] = await Promise.all([
      queueSavedRecordPush(created.customer, created.file),
      queueSavedRecordPush(edited.customer, edited.file),
    ])

    expect(state.calls).toEqual(["create", "update"])
    expect(state.rows).toBe(1)
    expect(first.feishu.recordId).toBe("rec1")
    expect(second.feishu.action).toBe("updated")
    expect(second.feishu.recordId).toBe("rec1")
    // The push re-reads the record inside the lock, so neither write carries a stale status.
    expect(state.statuses).toEqual(["已解决", "已解决"])

    const onDisk = await getRecord(created.customer, noExt)
    expect(onDisk?.feishuRecordId).toBe("rec1")
    expect(onDisk?.status).toBe("已解决")
  })

  it("writes the status of the second save into the update payload", async () => {
    const created = await createRecord(draft())
    const noExt = created.file.replace(/\.md$/, "")
    await updateRecord(created.customer, noExt, { status: "已解决" })
    const pushed = await queueSavedRecordPush(created.customer, created.file)
    expect(pushed.feishu.ok).toBe(true)
    // The push re-reads the record inside the lock, so the record it pushed carries the new status.
    expect(pushed.record.status).toBe("已解决")
    expect(state.statuses).toEqual(["已解决"])
  })
})
