import { describe, expect, it, vi } from "vitest"
import type { TranscriptTurn } from "./types"

/**
 * T11 review 2: one screenshot that fails must not throw away the others.
 * The vision model and the text model are mocked; the merge/placeholder/uncertain
 * wiring in vl.ts is the real code.
 */
vi.mock("./ai", () => ({
  extractRecord: async () => ({
    mode: "ai" as const,
    warning: "规则提示",
    draft: { title: "极耳定位偏移", uncertain: ["已有不确定项"] },
  }),
}))

vi.mock("./feishu-schema-load", () => ({
  loadFeishuSchemaState: async () => ({ ok: true, schema: {}, path: "" }),
}))

process.env.DASHSCOPE_API_KEY = "test-key"
const { extractFromScreenshots, VlExtractError } = await import("./vl")

const IMG_OK = Buffer.from("IMG-OK")
const IMG_FAIL = Buffer.from("IMG-FAIL")

function visionResponse(body: { messages?: { content?: { type?: string; image_url?: { url?: string } }[] }[] }): Response {
  const url = body.messages?.[0]?.content?.[0]?.image_url?.url ?? ""
  if (url.endsWith(IMG_FAIL.toString("base64"))) {
    return new Response("boom", { status: 500 })
  }
  const transcript: TranscriptTurn[] = [{ speaker: "客户", text: "第一张的内容", kind: "speech" }]
  return Response.json({
    choices: [
      {
        finish_reason: "stop",
        message: { content: JSON.stringify({ window_title: "示例客户(12) 示例科技技术支持", transcript }) },
      },
    ],
  })
}

describe("extractFromScreenshots when one screenshot fails", () => {
  it("keeps the other screenshots and flags the failed one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => visionResponse(JSON.parse(String(init?.body)))),
    )
    const result = await extractFromScreenshots([IMG_OK, IMG_FAIL], {})

    expect(result.draft.chat).toContain("客户：第一张的内容")
    expect(result.draft.chat).toContain("系统：第 2 张截图转写失败，可重新整理或改用粘贴")
    expect(result.draft.uncertain).toContain("第 2 张截图转写失败，可重新整理或改用粘贴")
    expect(result.draft.uncertain).toContain("已有不确定项")
    expect(result.warning).toContain("第 2 张截图转写失败")
    expect(result.imageCount).toBe(2)
    vi.unstubAllGlobals()
  })

  it("still fails loudly when every screenshot fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    )
    await expect(extractFromScreenshots([IMG_FAIL, IMG_FAIL], {})).rejects.toBeInstanceOf(VlExtractError)
    vi.unstubAllGlobals()
  })
})
