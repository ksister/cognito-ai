import { describe, expect, it } from "vitest"
import { SERVER_MANAGED_KEYS, stripServerManagedFields } from "./record-patch"

describe("record-patch：客户端不能写飞书同步字段（T31）", () => {
  it("四个服务端字段全部被丢掉", () => {
    const patch = stripServerManagedFields({
      title: "t",
      feishuRecordId: "rec_client_supplied",
      feishuSynced: true,
      feishuSyncedAt: "2026-11-19T00:00:00.000Z",
      feishuAttached: ["a.jpg"],
    })
    for (const key of SERVER_MANAGED_KEYS) expect(patch).not.toHaveProperty(key)
    expect(patch.title).toBe("t")
  })

  it("普通记录字段原样保留", () => {
    const patch = stripServerManagedFields({ title: "t", status: "AE处理中", local_id: "AE-20261110-01" })
    expect(patch).toEqual({ title: "t", status: "AE处理中", local_id: "AE-20261110-01" })
  })

  it("不修改传入对象", () => {
    const input = { title: "t", feishuRecordId: "rec_x" }
    const patch = stripServerManagedFields(input)
    expect(input.feishuRecordId).toBe("rec_x")
    expect(patch).not.toHaveProperty("feishuRecordId")
  })

  it("没有这些字段时是恒等变换", () => {
    expect(stripServerManagedFields({ status: "已解决" })).toEqual({ status: "已解决" })
  })
})
