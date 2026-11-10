import { describe, expect, it } from "vitest"
import { enqueueFeishuWrite, recordKey } from "./feishu-jobs"

describe("per-record Feishu write queue", () => {
  it("runs two writes for the same record one after another", async () => {
    const log: string[] = []
    const key = recordKey("示例客户", "2026-11-10-极耳定位.md")
    const first = enqueueFeishuWrite(key, async () => {
      log.push("first:start")
      await new Promise((r) => setTimeout(r, 20))
      log.push("first:end")
      return "first"
    })
    const second = enqueueFeishuWrite(key, async () => {
      log.push("second:start")
      log.push("second:end")
      return "second"
    })
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"])
    expect(log).toEqual(["first:start", "first:end", "second:start", "second:end"])
  })

  it("does not make a different record wait", async () => {
    let releaseFirst!: () => void
    const gate = new Promise<void>((r) => {
      releaseFirst = r
    })
    const started: string[] = []
    const blocked = enqueueFeishuWrite(recordKey("示例客户", "a.md"), async () => {
      started.push("a")
      await gate
      return "a"
    })
    const other = enqueueFeishuWrite(recordKey("示例客户", "b.md"), async () => {
      started.push("b")
      return "b"
    })
    await expect(other).resolves.toBe("b")
    expect(started).toEqual(["a", "b"])
    releaseFirst()
    await expect(blocked).resolves.toBe("a")
  })

  it("keeps later writes working after one fails", async () => {
    const key = recordKey("示例客户", "c.md")
    await expect(
      enqueueFeishuWrite(key, async () => {
        throw new Error("lark-cli 未登录")
      }),
    ).rejects.toThrow("lark-cli 未登录")
    await expect(enqueueFeishuWrite(key, async () => "ok")).resolves.toBe("ok")
  })
})
