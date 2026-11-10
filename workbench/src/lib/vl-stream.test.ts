import { describe, expect, it, vi } from "vitest"
import type { ScreenshotProgress } from "./vl"

/**
 * T11「第一张转写先显示」: the transcript must appear as each screenshot is done, always
 * in image order, even though the screenshots are transcribed in parallel.
 * Vision model and text model are mocked; the streaming merge in vl.ts is the real code.
 */
vi.mock("./ai", () => ({
  extractRecord: async () => ({ mode: "ai" as const, draft: { title: "极耳定位偏移" } }),
}))
vi.mock("./feishu-schema-load", () => ({
  loadFeishuSchemaState: async () => ({ ok: true, schema: {}, path: "" }),
}))

process.env.DASHSCOPE_API_KEY = "test-key"
const { extractFromScreenshotsStream } = await import("./vl")

const imageOf = (tag: string) => Buffer.from(`IMG-${tag}`)
const b64 = (tag: string) => imageOf(tag).toString("base64")

type Plan = { delay: number; text: string; title?: string }

function stubVision(plans: Record<string, Plan>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: { content: { image_url?: { url?: string } }[] }[]
      }
      const url = body.messages[0].content[0].image_url?.url ?? ""
      const tag = Object.keys(plans).find((key) => url.endsWith(b64(key)))
      if (!tag) return new Response("unknown image", { status: 400 })
      const plan = plans[tag]
      await new Promise((r) => setTimeout(r, plan.delay))
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                window_title: plan.title ?? "",
                transcript: [{ speaker: "客户", text: plan.text, kind: "speech" }],
              }),
            },
          },
        ],
      })
    }),
  )
}

describe("extractFromScreenshotsStream", () => {
  it("pushes the transcript as soon as each screenshot is done", async () => {
    stubVision({
      A: { delay: 5, text: "第一张说的话", title: "锴士(12) 鉴泉技术支持" },
      B: { delay: 30, text: "第二张说的话" },
      C: { delay: 60, text: "第三张说的话" },
    })
    const events: ScreenshotProgress[] = []
    await extractFromScreenshotsStream([imageOf("A"), imageOf("B"), imageOf("C")], {}, (p) => events.push(p))

    expect(events.map((e) => e.done)).toEqual([1, 2, 3])
    expect(events[0].chat).toContain("客户：第一张说的话")
    expect(events[0].chat).not.toContain("第二张说的话")
    expect(events[1].chat).toContain("客户：第二张说的话")
    expect(events[2].chat).toContain("客户：第三张说的话")
    expect(events[0].total).toBe(3)
    expect(events[0].windowTitle).toBe("锴士(12) 鉴泉技术支持")
  })

  it("keeps image order when a later screenshot finishes first", async () => {
    stubVision({
      A: { delay: 60, text: "第一张说的话" },
      B: { delay: 5, text: "第二张说的话" },
      C: { delay: 5, text: "第三张说的话" },
    })
    const events: ScreenshotProgress[] = []
    await extractFromScreenshotsStream([imageOf("A"), imageOf("B"), imageOf("C")], {}, (p) => events.push(p))

    // Nothing usable is shown until the first screenshot is done, then all three in order.
    expect(events).toHaveLength(1)
    const chat = events[0].chat
    expect(events[0].done).toBe(3)
    expect(chat.indexOf("第一张说的话")).toBeLessThan(chat.indexOf("第二张说的话"))
    expect(chat.indexOf("第二张说的话")).toBeLessThan(chat.indexOf("第三张说的话"))
    vi.unstubAllGlobals()
  })
})
