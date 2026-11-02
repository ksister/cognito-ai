import { describe, expect, it } from "vitest"
import { larkAuthExpiryMessage } from "./lark-auth-error"

describe("larkAuthExpiryMessage", () => {
  it("detects refresh token expired", () => {
    const msg = larkAuthExpiryMessage({ type: "auth", subtype: "token_expired", message: "refresh token expired" })
    expect(msg).toContain("lark-cli auth login")
    expect(msg).toContain("复制为飞书行")
  })

  it("detects Chinese 登录已过期", () => {
    expect(larkAuthExpiryMessage({ message: "登录已过期" })).toContain("重新登录")
  })

  it("returns null for non-auth errors", () => {
    expect(larkAuthExpiryMessage({ type: "config", message: "not configured" })).toBeNull()
    expect(larkAuthExpiryMessage({ message: "table not found" })).toBeNull()
  })
})
