import { describe, expect, it } from "vitest"
import {
  customerCandidatesInTitle,
  customerFromWindowTitle,
  fuzzyCustomerOption,
  normalizeExtractedDraft,
  parseFeishuTableSchema,
  pickCustomerFromTitle,
} from "./feishu-schema"

/**
 * T18: the chat window title is a customer clue. Fictional names only — the public repo must not
 * contain real customer names. Title shape under test: 「客户名(人数) 我方公司技术支持」.
 */
const schema = parseFeishuTableSchema({
  version: 1,
  columns: [
    {
      name: "客户公司1",
      type: "select",
      key: "customer",
      extract: true,
      options: ["星河精密", "云帆科技", "天穹包装"],
      aliases: { 星河: "星河精密" },
      aiSkip: ["其他-待确认"],
    },
  ],
})
const customer = schema.columns[0]

describe("customer from window title", () => {
  it("takes the name before the member count, not our company next to 技术支持", () => {
    expect(pickCustomerFromTitle("星河精密(12) 云帆科技技术支持", customer)).toMatchObject({
      value: "星河精密",
      confidence: "high",
    })
    expect(customerFromWindowTitle("", "星河精密(12) 云帆科技技术支持", customer).value).toBe("星河精密")
  })

  it("resolves a configured alias in the title", () => {
    expect(pickCustomerFromTitle("星河(8) 云帆科技技术支持群", customer).value).toBe("星河精密")
  })

  it("accepts a title with a single configured customer", () => {
    expect(pickCustomerFromTitle("天穹包装-王工", customer)).toMatchObject({
      value: "天穹包装",
      confidence: "medium",
    })
  })

  it("keeps a model value when the title has no strong customer clue", () => {
    expect(customerFromWindowTitle("天穹包装", "云帆科技技术支持", customer)).toEqual({
      value: "",
      uncertain: [],
    })
  })

  it("corrects our own company picked from the same title", () => {
    const corrected = customerFromWindowTitle("云帆科技", "星河精密(12) 云帆科技技术支持", customer)
    expect(corrected.value).toBe("星河精密")
    expect(corrected.uncertain[0]).toMatch(/云帆科技/)
    expect(corrected.uncertain[0]).toMatch(/星河精密/)
  })

  it("never picks an aiSkip option and reports ambiguity instead of guessing", () => {
    const ambiguous = parseFeishuTableSchema({
      version: 1,
      columns: [
        {
          name: "客户公司1",
          type: "select",
          key: "customer",
          extract: true,
          options: ["星河精密", "星海精密"],
          aiSkip: ["其他-待确认"],
        },
      ],
    })
    expect(customerCandidatesInTitle("星河精密 星海精密", ambiguous.columns[0])).toHaveLength(2)
    const pick = pickCustomerFromTitle("星河精密 星海精密", ambiguous.columns[0])
    expect(pick.confidence).not.toBe("high")
  })
})

describe("fuzzy customer for OCR near-misses", () => {
  it("maps a one-character OCR error onto the only nearby option", () => {
    expect(fuzzyCustomerOption("星何精密", customer)).toBe("星河精密")
    expect(fuzzyCustomerOption("云帆科枝", customer)).toBe("云帆科技")
  })

  it("does not guess when two options are one character away", () => {
    const near = parseFeishuTableSchema({
      version: 1,
      columns: [
        {
          name: "客户公司1",
          type: "select",
          key: "customer",
          extract: true,
          options: ["星河精密", "星河精工"],
        },
      ],
    })
    expect(fuzzyCustomerOption("星河精X", near.columns[0])).toBe("")
  })

  it("ignores exact options and short text", () => {
    expect(fuzzyCustomerOption("星河精密", customer)).toBe("")
    expect(fuzzyCustomerOption("星", customer)).toBe("")
  })

  it("writes the matched option and a confirmation note into the draft", () => {
    const out = normalizeExtractedDraft({ customer: "星何精密", uncertain: [] }, schema)
    expect(out.customer).toBe("星河精密")
    expect(out.uncertain?.join("\n")).toMatch(/相近字/)
    expect(out.uncertain?.join("\n")).toMatch(/星何精密/)
  })
})
