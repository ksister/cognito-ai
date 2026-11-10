import { readProfileContext } from "@/lib/kb"
import { extractFromScreenshotsStream, MAX_SCREENSHOTS, VlExtractError, type ScreenshotProgress } from "@/lib/vl"
import type { ExtractErrorCode, ExtractResult } from "@/lib/types"

/**
 * Screenshot extract as Server-Sent Events so the first transcript can be shown at once
 * (T11「第一张转写先显示」). Events: `progress` (per finished screenshot, image order),
 * then `draft`, or `error`.
 */
export const dynamic = "force-dynamic"

/** Tell proxies not to buffer the stream (Next dev, and anything in front in the future). */
const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const

function badRequest(message: string, code: ExtractErrorCode = "parse_error") {
  return Response.json({ error: message, code }, { status: 400 })
}

export async function POST(req: Request) {
  const ctype = req.headers.get("content-type") ?? ""
  if (!ctype.includes("multipart/form-data")) {
    return badRequest("截图流式提取只接受 multipart 上传（字段名 images）")
  }

  const form = await req.formData()
  const customer = String(form.get("customer") ?? "")
  const me = String(form.get("me") ?? "")
  const files = form.getAll("images").filter((f): f is File => typeof f !== "string")
  if (!files.length) return badRequest("请上传截图，或改用粘贴文字")
  if (files.length > MAX_SCREENSHOTS) return badRequest(`最多上传 ${MAX_SCREENSHOTS} 张截图`)

  const images: Buffer[] = []
  for (const f of files) images.push(Buffer.from(await f.arrayBuffer()))
  const profile = await readProfileContext()

  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The browser may go away mid-stream; a closed controller must not throw into the task.
      const send = (event: ExtractResult | ScreenshotProgress | { type: string; [k: string]: unknown }) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          // Client disconnected.
        }
      }
      try {
        const result = await extractFromScreenshotsStream(images, { customer, me, profile }, (p) => {
          send({ type: "progress", ...p })
        })
        send({ type: "draft", result })
      } catch (e) {
        const code: ExtractErrorCode = e instanceof VlExtractError ? e.code : "parse_error"
        send({ type: "error", code, message: (e as Error)?.message || "截图提取失败" })
      } finally {
        try {
          controller.close()
        } catch {
          // Already closed.
        }
      }
    },
  })

  return new Response(body, { headers: SSE_HEADERS })
}
