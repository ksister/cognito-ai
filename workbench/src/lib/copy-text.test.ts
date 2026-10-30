import { describe, expect, it } from "vitest"
import { CopyTextError, copyFetchedText, copyText } from "./copy-text"

describe("copyText", () => {
  it("rejects empty text", async () => {
    await expect(copyText("")).rejects.toBeInstanceOf(CopyTextError)
  })

  it("still returns the text promise when ClipboardItem is unavailable", async () => {
    const started = copyFetchedText(async () => "a\tb")
    expect(started.text).toBeInstanceOf(Promise)
    await expect(started.text).resolves.toBe("a\tb")
    expect(started.write).toBeNull()
  })
})
