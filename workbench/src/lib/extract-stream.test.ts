import { describe, expect, it } from "vitest"
import { parseSseBuffer } from "./extract-stream"

describe("parseSseBuffer", () => {
  it("returns the complete events and keeps the unfinished tail", () => {
    const buffer = 'data: {"type":"progress","done":1,"total":2,"chat":"a"}\n\ndata: {"type":"draft","res'
    const { events, rest } = parseSseBuffer(buffer)
    expect(events).toEqual([{ type: "progress", done: 1, total: 2, chat: "a" }])
    expect(rest).toBe('data: {"type":"draft","res')
  })

  it("skips comments and malformed payloads", () => {
    const buffer = ': ping\n\ndata: not-json\n\ndata: {"type":"error","message":"x"}\n\n'
    expect(parseSseBuffer(buffer).events).toEqual([{ type: "error", message: "x" }])
  })

  it("handles CRLF line endings", () => {
    const buffer = 'data: {"type":"progress","done":2,"total":2,"chat":"b"}\r\n\r\n'
    expect(parseSseBuffer(buffer).events).toHaveLength(1)
  })

  it("returns nothing for a buffer without a full event yet", () => {
    expect(parseSseBuffer('data: {"type":"prog').events).toEqual([])
  })
})
