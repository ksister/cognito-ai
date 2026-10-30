import { describe, expect, it } from "vitest"
import {
  RECORD_NOT_READY_CODE,
  RECORD_NOT_READY_DELAY_MS,
  cliRelativeFile,
  extractCliRecordId,
  feishuFailureMessage,
  feishuOutcomeMessage,
  feishuSyncPatchFromPush,
  isRecordNotReady,
  omitAttachmentFields,
  pushActionFor,
  sameRowUpdateError,
  screenshotsToUpload,
} from "./lark-push-plan"

const ROW = "rec_example_same"
const OTHER = "rec_example_other"

describe("feishu push plan", () => {
  it("updates only when a record id is already stored", () => {
    expect(pushActionFor("")).toBe("create")
    expect(pushActionFor("   ")).toBe("create")
    expect(pushActionFor(undefined)).toBe("create")
    expect(pushActionFor(ROW)).toBe("update")
  })

  it("uploads new screenshot names and leaves ones already attached", () => {
    expect(screenshotsToUpload(["a.jpg", "b.jpg", "a.jpg"], ["a.jpg"])).toEqual(["b.jpg"])
    expect(screenshotsToUpload(["a.jpg"], undefined)).toEqual(["a.jpg"])
    expect(screenshotsToUpload(["a.jpg"], ["a.jpg"])).toEqual([])
  })

  it("treats 800030405 as the not-ready race, including when it is only in the message", () => {
    expect(RECORD_NOT_READY_DELAY_MS).toBe(1500)
    expect(isRecordNotReady(800030405)).toBe(true)
    expect(isRecordNotReady(RECORD_NOT_READY_CODE)).toBe(true)
    expect(isRecordNotReady("cli_error", "code 800030405 not_found")).toBe(true)
    expect(isRecordNotReady(1254043, "missing field")).toBe(false)
  })

  it("reads the upsert id from data.record.record_id_list[0]", () => {
    expect(
      extractCliRecordId({
        data: { record: { record_id_list: [ROW] } },
      }),
    ).toBe(ROW)
    expect(extractCliRecordId({ data: { records: [{ record_id: OTHER }] } })).toBe(OTHER)
    expect(extractCliRecordId({ record_id: ROW })).toBe(ROW)
    expect(extractCliRecordId(null)).toBeUndefined()
  })

  it("rejects an update that created a second row", () => {
    expect(sameRowUpdateError({ updated: true, data: { record: { record_id_list: [ROW] } } }, ROW)).toBeNull()
    expect(sameRowUpdateError({ created: true }, ROW)).toMatch(/创建了新行/)
    expect(sameRowUpdateError({ updated: false }, ROW)).toMatch(/updated=false/)
    expect(sameRowUpdateError({ data: { record: { record_id_list: [OTHER] } } }, ROW)).toMatch(/另一个 record_id/)
    expect(sameRowUpdateError(null, ROW)).toBeNull()
  })

  it("drops the attachment column from the field payload", () => {
    const fields = omitAttachmentFields(
      { fld_example_title: "标题", fld_example_file: [{ file_token: "x" }] },
      ["fld_example_file"],
    )
    expect(fields).toEqual({ fld_example_title: "标题" })
  })

  it("accepts a cwd-relative --file path and refuses an outside absolute path", () => {
    expect(cliRelativeFile("/work/workbench", "/work/workbench/.tmp/shot.jpg")).toBe(".tmp/shot.jpg")
    expect(cliRelativeFile("/work/workbench", "customers/示例/files/a.jpg")).toBe("customers/示例/files/a.jpg")
    expect(cliRelativeFile("/work/workbench", "/private/kb/customers/示例/files/a.jpg")).toBeNull()
    expect(cliRelativeFile("/work/workbench", "/work/shot.jpg")).toBeNull()
  })

  it("tells created and updated apart, and says an update is the same row", () => {
    expect(feishuOutcomeMessage("created", ROW)).toBe(`已新建飞书行 ${ROW}`)
    expect(feishuOutcomeMessage("updated", ROW)).toContain("同一飞书行")
    expect(feishuOutcomeMessage("updated", ROW)).toContain(ROW)
    expect(feishuOutcomeMessage("updated", ROW)).toContain("没有新建第二行")
    expect(
      feishuFailureMessage({
        action: "updated",
        error: "超时",
        recordId: ROW,
        steps: [{ step: "update", ok: false }],
      }),
    ).toContain("没有新建第二行")
  })

  it("persists the id after create, and a later failure still keeps that id", () => {
    const created = feishuSyncPatchFromPush(
      { ok: true, recordId: ROW, attachedNames: ["a.jpg"] },
      [],
      "2026-10-30T02:00:00.000Z",
    )
    expect(created).toEqual({
      feishuRecordId: ROW,
      feishuSynced: true,
      feishuSyncedAt: "2026-10-30T02:00:00.000Z",
      feishuAttached: ["a.jpg"],
    })

    const failedUpdate = feishuSyncPatchFromPush(
      { ok: false, recordId: ROW, attachedNames: [] },
      ["a.jpg"],
      "2026-10-30T03:00:00.000Z",
    )
    expect(failedUpdate?.feishuRecordId).toBe(ROW)
    expect(failedUpdate?.feishuSynced).toBe(false)
    expect(failedUpdate?.feishuSyncedAt).toBeUndefined()
    expect(failedUpdate?.feishuAttached).toEqual(["a.jpg"])

    const again = feishuSyncPatchFromPush(
      { ok: true, recordId: ROW, attachedNames: ["b.jpg"] },
      ["a.jpg"],
      "2026-10-30T04:00:00.000Z",
    )
    expect(again?.feishuRecordId).toBe(ROW)
    expect(again?.feishuAttached).toEqual(["a.jpg", "b.jpg"])

    expect(feishuSyncPatchFromPush({ ok: false }, [], "2026-10-30T05:00:00.000Z")).toBeNull()
  })
})
