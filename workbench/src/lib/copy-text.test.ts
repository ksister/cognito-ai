import { describe, expect, it } from "vitest"
import { CopyTextError, copyText } from "./copy-text"

describe("copyText", () => {
  it("rejects empty text instead of reporting success", async () => {
    await expect(copyText("")).rejects.toBeInstanceOf(CopyTextError)
    await expect(copyText("")).rejects.toThrow(/空字符串/)
  })

  it("includes the failure reason and the original text when no clipboard exists", async () => {
    try {
      await copyText("日期\t客户")
      throw new Error("copyText should fail in node")
    } catch (e) {
      if ((e as Error).message === "copyText should fail in node") throw e
      expect(e).toBeInstanceOf(CopyTextError)
      const err = e as CopyTextError
      expect(err.message).toMatch(/剪贴板|execCommand|安全上下文|clipboard/)
      expect(err.text).toBe("日期\t客户")
    }
  })
})
