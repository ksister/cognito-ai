import type { ExtractErrorCode, ExtractResult } from "./types"

/**
 * Client side of the streaming screenshot extract (T11「第一张转写先显示」).
 * `/api/extract/stream` answers with Server-Sent Events:
 *   {type:"progress"} after each screenshot, then {type:"draft"} with the fields,
 *   or {type:"error"}.
 */
export type ExtractStreamEvent =
  | { type: "progress"; done: number; total: number; chat: string }
  | { type: "draft"; result: ExtractResult }
  | { type: "error"; code?: ExtractErrorCode; message: string }

export type ExtractProgressEvent = Extract<ExtractStreamEvent, { type: "progress" }>

/**
 * Split an SSE byte buffer into complete `data:` payloads. Pure: same text -> same events.
 * Returns the unfinished tail so the caller can prepend it to the next chunk.
 */
export function parseSseBuffer(buffer: string): { events: ExtractStreamEvent[]; rest: string } {
  const events: ExtractStreamEvent[] = []
  let rest = buffer.replace(/\r\n/g, "\n")
  for (;;) {
    const sep = rest.indexOf("\n\n")
    if (sep < 0) break
    const chunk = rest.slice(0, sep)
    rest = rest.slice(sep + 2)
    for (const line of chunk.split("\n")) {
      const trimmed = line.trimStart()
      if (!trimmed.startsWith("data:")) continue
      const payload = trimmed.slice(5).trim()
      if (!payload) continue
      try {
        events.push(JSON.parse(payload) as ExtractStreamEvent)
      } catch {
        // A malformed event is skipped; the stream keeps going.
      }
    }
  }
  return { events, rest }
}

export class ExtractStreamError extends Error {
  code?: ExtractErrorCode
  constructor(message: string, code?: ExtractErrorCode) {
    super(message)
    this.code = code
    this.name = "ExtractStreamError"
  }
}

/** POST the screenshots and read events until the draft arrives. */
export async function streamExtract(
  form: FormData,
  handlers: { onProgress?: (event: ExtractProgressEvent) => void } = {},
): Promise<ExtractResult> {
  const res = await fetch("/api/extract/stream", { method: "POST", body: form })
  if (!res.ok || !res.body) {
    let message = `提取失败（HTTP ${res.status}）`
    let code: ExtractErrorCode | undefined
    try {
      const j = (await res.json()) as { error?: string; code?: ExtractErrorCode }
      if (j.error) message = j.error
      code = j.code
    } catch {
      // Keep the HTTP message.
    }
    throw new ExtractStreamError(message, code)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let draft: ExtractResult | undefined
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: true })
    const parsed = parseSseBuffer(buffer)
    buffer = parsed.rest
    for (const event of parsed.events) {
      if (event.type === "progress") handlers.onProgress?.(event)
      else if (event.type === "draft") draft = event.result
      else if (event.type === "error") throw new ExtractStreamError(event.message, event.code)
    }
    if (done) break
  }
  if (!draft) throw new ExtractStreamError("流式提取提前结束，没有拿到字段结果，可重试或改用粘贴文字")
  return draft
}
