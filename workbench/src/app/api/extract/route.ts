import { extractRecord } from "@/lib/ai"
import { FeishuSchemaError } from "@/lib/feishu-schema"
import { readProfileContext } from "@/lib/kb"
import { extractFromScreenshots, MAX_SCREENSHOTS, VlExtractError } from "@/lib/vl"
import type { ExtractErrorCode } from "@/lib/types"

function err(code: ExtractErrorCode, message: string, status = 400) {
  return Response.json({ error: message, code }, { status })
}

async function buffersFromForm(form: FormData): Promise<Buffer[]> {
  const files = form.getAll("images").filter((f): f is File => typeof f !== "string")
  if (files.length > MAX_SCREENSHOTS) {
    throw new VlExtractError("parse_error", `最多上传 ${MAX_SCREENSHOTS} 张截图`)
  }
  const out: Buffer[] = []
  for (const f of files) {
    out.push(Buffer.from(await f.arrayBuffer()))
  }
  return out
}

export async function POST(req: Request) {
  const profile = await readProfileContext()
  const ctype = req.headers.get("content-type") ?? ""

  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData()
    const customer = String(form.get("customer") ?? "")
    const me = String(form.get("me") ?? "")
    let images: Buffer[]
    try {
      images = await buffersFromForm(form)
    } catch (e) {
      if (e instanceof VlExtractError) return err(e.code, e.message)
      throw e
    }
    if (!images.length) return err("parse_error", "请上传截图，或改用粘贴文字")
    try {
      return Response.json(await extractFromScreenshots(images, { customer, me, profile }))
    } catch (e) {
      if (e instanceof VlExtractError) {
        const status = e.code === "auth" ? 401 : e.code === "rate_limit" ? 429 : e.code === "timeout" ? 504 : 400
        return err(e.code, e.message, status)
      }
      return err("parse_error", `截图提取失败：${(e as Error).message}`)
    }
  }

  const body = (await req.json()) as { chat?: string; customer?: string; me?: string; images?: unknown }
  if (body.images) {
    return err("parse_error", "截图请使用 multipart 上传（字段名 images）")
  }
  if (!body.chat?.trim()) return Response.json({ error: "聊天记录为空" }, { status: 400 })
  try {
    const result = await extractRecord(body.chat, {
      customer: body.customer,
      me: body.me,
      profile,
    })
    return Response.json({ ...result, source: result.source ?? "paste" })
  } catch (e) {
    if (e instanceof FeishuSchemaError) return err("parse_error", e.message)
    return err("parse_error", `文字提取失败：${(e as Error).message}`)
  }
}
