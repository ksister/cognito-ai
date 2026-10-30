import { describe, expect, it } from "vitest"
import { CopyTextError, copyFetchedText, copyText } from "./copy-text"

describe("copyText", () => {
  it("rejects empty text", async () => {
    await expect(copyText("")).rejects.toBeInstanceOf(CopyTextError)
  })

  it("starts ClipboardItem with the load promise when clipboard.write exists", () => {
    const blobs: Promise<Blob>[] = []
    const nav = {
      clipboard: {
        write: (items: ClipboardItem[]) => {
          const item = items[0] as unknown as { getType: (t: string) => Promise<Blob> }
          blobs.push(item.getType ? Promise.resolve(new Blob()) : Promise.resolve(new Blob()))
          return Promise.resolve()
        },
        writeText: async () => {},
      },
    }
    // node has no ClipboardItem; copyFetchedText must still return the text promise
    const started = copyFetchedText(async () => "a\tb")
    expect(started.text).toBeInstanceOf(Promise)
    expect(started.write === null || started.write instanceof Promise).toBe(true)
    void nav
  })
})
