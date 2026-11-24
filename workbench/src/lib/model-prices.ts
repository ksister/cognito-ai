import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

/**
 * Model unit prices live in the private KB (`KB_DIR/config/model-prices.json`)
 * and must come from the user-verified source noted in that file (坑 20).
 * Shared by the T25 export script, the T26 snapshot and the cost estimate —
 * never hardcode prices in code.
 *
 * Script-safe: no `server-only`, `.ts` suffix on relative runtime imports.
 */

export type ModelPrices = {
  ok: boolean
  reason?: string
  unit: string
  currency: string
  updatedAt: string
  models: Record<string, { inputPerMillion?: number | null; outputPerMillion?: number | null }>
}

export type ModelPrice = { key: string; input: number | null; output: number | null; priced: boolean } | null

export async function readModelPrices(kbDir: string): Promise<ModelPrices> {
  const file = path.join(kbDir, "config", "model-prices.json")
  if (!fs.existsSync(file)) {
    return { ok: false, reason: "没有 config/model-prices.json", unit: "", currency: "", updatedAt: "", models: {} }
  }
  try {
    const json = JSON.parse(await fsp.readFile(file, "utf8")) as Partial<ModelPrices>
    return {
      ok: true,
      unit: json?.unit ?? "",
      currency: json?.currency ?? "",
      updatedAt: json?.updatedAt ?? "",
      models: (json?.models ?? {}) as ModelPrices["models"],
    }
  } catch {
    return { ok: false, reason: "model-prices.json 解析失败", unit: "", currency: "", updatedAt: "", models: {} }
  }
}

export function priceFor(prices: ModelPrices | { ok: false }, model: string): ModelPrice {
  if (!prices?.ok) return null
  const models = (prices as ModelPrices).models || {}
  const keys = Object.keys(models)
  const key = keys.find((k) => k === model) || keys.find((k) => model && (model.includes(k) || k.includes(model)))
  if (!key) return null
  const e = models[key]
  const input = typeof e?.inputPerMillion === "number" ? e.inputPerMillion : null
  const output = typeof e?.outputPerMillion === "number" ? e.outputPerMillion : null
  return { key, input, output, priced: input != null && output != null }
}

export function estimateCost({
  promptTokens,
  completionTokens,
  price,
}: {
  promptTokens: number
  completionTokens: number
  price: ModelPrice
}): number | null {
  if (!price?.priced) return null
  return (promptTokens / 1_000_000) * (price.input ?? 0) + (completionTokens / 1_000_000) * (price.output ?? 0)
}
