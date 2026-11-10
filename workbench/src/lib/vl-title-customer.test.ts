import { describe, expect, it, vi } from "vitest"
import { parseFeishuTableSchema } from "./feishu-schema"

/**
 * T18: screenshot extraction must (a) use the window title as a customer clue even when the text
 * model leaves the customer blank, (b) never save 「□」/「�」, (c) write emoji as 「[表情]」,
 * and (d) never keep the title as a chat message. Fictional names only.
 */
const schema = parseFeishuTableSchema({
  version: 1,
  columns: [
    {
      name: "问题名称",
      type: "text",
      key: "title",
      extract: true,
    },
    {
      name: "客户公司1",
      type: "select",
      key: "customer",
      extract: true,
      options: ["星河精密", "云帆科技"],
    },
    {
      name: "客户/联系人",
      type: "text",
      key: "contact",
      extract: true,
    },
  ],
})

const mockState = vi.hoisted(() => ({ customer: "", seen: [] as string[] }))
vi.mock("./ai", () => ({
  extractRecord: async (chat: string) => {
    mockState.seen.push(chat)
    return {
      mode: "ai" as const,
      draft: { title: "定位偏移", customer: mockState.customer, uncertain: [] },
    }
  },
}))
vi.mock("./feishu-schema-load", () => ({
  loadFeishuSchemaState: async () => ({ ok: true, schema, path: "" }),
}))

process.env.DASHSCOPE_API_KEY = "test-key"
const { extractFromScreenshots } = await import("./vl")

const IMG = Buffer.from("IMG-T18")
const TITLE = "星河精密(12) 云帆科技技术支持"

function stubVision(transcript: { speaker: string; text: string; kind: string }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ window_title: TITLE, transcript }) },
          },
        ],
      }),
    ),
  )
}

describe("screenshot extract transcript quality (T18)", () => {
  it("uses the title for the customer and cleans the transcript", async () => {
    mockState.customer = ""
    stubVision([
      { speaker: "客户", text: TITLE, kind: "speech" },
      { speaker: "客户", text: "定位偏了🌞，型号 A7□ 报错", kind: "speech" },
    ])
    const result = await extractFromScreenshots([IMG], {})

    expect(result.draft.customer).toBe("星河精密")
    expect(result.draft.chat).toContain("客户：定位偏了[表情]，型号 A7 报错")
    expect(result.draft.chat).not.toMatch(/[□\uFFFD]/)
    expect(result.draft.chat).not.toContain(TITLE)
    expect(result.draft.uncertain?.join("\n")).toMatch(/窗口标题/)
    expect(mockState.seen[0]).toContain(`[聊天窗口标题] ${TITLE}`)
    expect(mockState.seen[0]).toContain("人数前的是客户")
    vi.unstubAllGlobals()
  })

  it("corrects our own company picked out of the same title", async () => {
    mockState.customer = "云帆科技"
    stubVision([{ speaker: "客户", text: "在吗", kind: "speech" }])
    const result = await extractFromScreenshots([IMG], {})
    expect(result.draft.customer).toBe("星河精密")
    expect(result.draft.uncertain?.join("\n")).toMatch(/云帆科技/)
    vi.unstubAllGlobals()
  })
})
