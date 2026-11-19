import { describe, expect, it } from "vitest"
import { stripFeishuRecordId } from "./record-patch"

describe("record-patch：客户端不能写 feishu_record_id（T31）", () => {
  it("丢掉客户端传入的 feishuRecordId", () => {
    const patch = stripFeishuRecordId({ status: "已解决", feishuRecordId: "rec_client_supplied" })
    expect(patch).not.toHaveProperty("feishuRecordId")
    expect(patch.status).toBe("已解决")
  })

  it("其它字段原样保留", () => {
    const patch = stripFeishuRecordId({
      title: "t",
      status: "AE处理中",
      feishuSynced: true,
      feishuRecordId: "rec_x",
    })
    expect(patch.title).toBe("t")
    expect(patch.status).toBe("AE处理中")
    // 只按评审要求处理 feishu_record_id；其它同步字段不在本次范围
    expect(patch.feishuSynced).toBe(true)
  })

  it("没有该字段时不影响原对象", () => {
    const input = { title: "t" }
    const patch = stripFeishuRecordId(input)
    expect(patch).toEqual({ title: "t" })
    expect(input).toEqual({ title: "t" })
  })
})
