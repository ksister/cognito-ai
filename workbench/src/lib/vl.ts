import "server-only"
import {
  CATEGORIES,
  CHANNELS,
  NEED_TYPES,
  type ExtractErrorCode,
  type ExtractResult,
  type RecordDraft,
} from "./types"

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY
const DASHSCOPE_BASE_URL = (
  process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"
).replace(/\/$/, "")
const DASHSCOPE_VL_MODEL = process.env.DASHSCOPE_VL_MODEL ?? "qwen3-vl-plus"

export const MAX_SCREENSHOTS = 9

export function vlConfigured() {
  return Boolean(DASHSCOPE_API_KEY)
}

export function vlLabel() {
  return DASHSCOPE_API_KEY ? DASHSCOPE_VL_MODEL : "未配置通义 VL"
}

export class VlExtractError extends Error {
  code: ExtractErrorCode
  constructor(code: ExtractErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = "VlExtractError"
  }
}

const EXTRACT_VL_SYSTEM = `你是一名机器视觉公司的 AE（应用工程师）助理。用户会按时间顺序上传多张微信或飞书的技术支持聊天截图，你要合并为同一会话，整理成结构化的技术支持记录。

严格要求：
1. 只根据截图中可见的文字与界面信息整理，不要编造原文没有的事实。看不清或不确定的字段填 null，并写入 uncertain。
2. 多张截图按上传顺序拼接为同一段对话，不要当成多条独立记录。
3. 凡是不确定的地方（客户名、型号、版本、是否真正解决、因果关系、指代不清等），都写进 uncertain，每条写清楚「哪里不确定 + 截图依据」。
4. needs 用来沉淀产品需求线索：从抱怨、绕路做法、「能不能/希望/太麻烦」等表达中提炼。没有就返回空数组。
5. 使用简体中文，简洁具体，保留关键参数。只输出 JSON，不要 Markdown 围栏或其他说明。

输出 JSON，字段如下：
{
  "title": "一句话标题，20字内",
  "date": "YYYY-MM-DD，聊天中最早的日期，找不到就 null",
  "contact": "客户方联系人，未知 null",
  "channel": "${CHANNELS.join("|")}",
  "product": "涉及的软件/产品及版本，未知 null",
  "module": "涉及的功能模块，未知 null",
  "category": "${CATEGORIES.join("|")}",
  "status": "待处理|跟进中|已解决|已关闭",
  "problem": "客户遇到的问题",
  "process": "排查与沟通过程，用 1. 2. 3. 分步",
  "solution": "最终解决方案或当前结论",
  "needs": [{"pain": "用户痛点", "idea": "改进或工具想法", "type": "${NEED_TYPES.join("|")}"}],
  "uncertain": ["需要人工确认的点"]
}`

function mimeOf(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg"
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png"
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif"
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp"
  return "image/jpeg"
}

function nullToEmpty(v: unknown): string {
  if (v === null || v === undefined) return ""
  return String(v)
}

function normalizeDraft(d: Record<string, unknown>): Partial<RecordDraft> {
  const needs = Array.isArray(d.needs) ? d.needs : []
  const uncertain = Array.isArray(d.uncertain) ? d.uncertain.map((u) => String(u)) : []
  const dateRaw = d.date
  const date =
    typeof dateRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : undefined
  return {
    title: nullToEmpty(d.title),
    ...(date ? { date } : {}),
    contact: nullToEmpty(d.contact),
    channel: (CHANNELS.includes(d.channel as never) ? d.channel : "微信") as RecordDraft["channel"],
    product: nullToEmpty(d.product),
    module: nullToEmpty(d.module),
    category: nullToEmpty(d.category) || "使用咨询",
    status: (["待处理", "跟进中", "已解决", "已关闭"].includes(d.status as string)
      ? d.status
      : "跟进中") as RecordDraft["status"],
    problem: nullToEmpty(d.problem),
    process: nullToEmpty(d.process),
    solution: nullToEmpty(d.solution),
    needs: needs
      .map((n) => {
        const row = n as { pain?: unknown; idea?: unknown; type?: unknown }
        return {
          pain: nullToEmpty(row.pain),
          idea: nullToEmpty(row.idea),
          type: (NEED_TYPES.includes(row.type as never) ? row.type : "其他") as RecordDraft["needs"][number]["type"],
        }
      })
      .filter((n) => n.pain || n.idea),
    uncertain,
  }
}

function mapHttpError(status: number, body: string): VlExtractError {
  if (status === 401 || status === 403) {
    return new VlExtractError("auth", "通义 VL 鉴权失败，请检查 DASHSCOPE_API_KEY")
  }
  if (status === 429) {
    return new VlExtractError("rate_limit", "通义 VL 触发限流，请稍后再试")
  }
  if (status === 400 && /unsafe|content|risk|敏感/i.test(body)) {
    return new VlExtractError("unsafe", "截图内容被安全策略拒绝，请改用粘贴文字")
  }
  return new VlExtractError("parse_error", `通义 VL 接口返回 ${status}: ${body.slice(0, 180)}`)
}

/** Compress image buffer: long edge ≤ maxEdge, JPEG quality, size soft-cap. */
export async function compressImageBuffer(
  input: Buffer,
  opts: { maxEdge?: number; quality?: number; maxBytes?: number } = {},
): Promise<Buffer> {
  const maxEdge = opts.maxEdge ?? 2048
  const quality = opts.quality ?? 82
  const maxBytes = opts.maxBytes ?? 1_500_000
  try {
    const sharp = (await import("sharp")).default
    let img = sharp(input).rotate()
    const meta = await img.metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    if (w > maxEdge || h > maxEdge) {
      img = img.resize({
        width: w >= h ? maxEdge : undefined,
        height: h > w ? maxEdge : undefined,
        fit: "inside",
        withoutEnlargement: true,
      })
    }
    let out = await img.jpeg({ quality, mozjpeg: true }).toBuffer()
    if (out.length > maxBytes) {
      out = await sharp(out)
        .jpeg({ quality: Math.max(55, quality - 20), mozjpeg: true })
        .toBuffer()
    }
    return out
  } catch {
    return input
  }
}

export async function extractFromScreenshots(
  images: Buffer[],
  opts: { customer?: string; me?: string; profile?: string },
): Promise<ExtractResult> {
  if (!DASHSCOPE_API_KEY) {
    throw new VlExtractError("auth", "未配置 DASHSCOPE_API_KEY，无法从截图提取；请改用粘贴文字")
  }
  if (images.length === 0) {
    throw new VlExtractError("parse_error", "没有收到截图")
  }
  if (images.length > MAX_SCREENSHOTS) {
    throw new VlExtractError("parse_error", `最多 ${MAX_SCREENSHOTS} 张截图`)
  }

  const compressed: Buffer[] = []
  for (const raw of images) {
    compressed.push(await compressImageBuffer(raw))
  }

  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
  for (const buf of compressed) {
    const mime = mimeOf(buf)
    content.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${buf.toString("base64")}` },
    })
  }
  const hint = [
    opts.profile ? `【我的背景】\n${opts.profile}` : "",
    opts.customer ? `【客户】${opts.customer}` : "",
    opts.me ? `【我在聊天中的昵称】${opts.me}（其余发言人默认是客户方）` : "",
    `【说明】以上共 ${compressed.length} 张截图，按顺序为同一会话。请只输出 JSON。`,
  ]
    .filter(Boolean)
    .join("\n\n")
  content.push({ type: "text", text: hint })

  let res: Response
  try {
    res = await fetch(`${DASHSCOPE_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify({
        model: DASHSCOPE_VL_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EXTRACT_VL_SYSTEM },
          { role: "user", content },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" || /aborted|timeout/i.test((e as Error).message)
      ? "通义 VL 请求超时"
      : `通义 VL 网络错误：${(e as Error).message}`
    throw new VlExtractError(
      /timeout|aborted/i.test(msg) ? "timeout" : "parse_error",
      msg + "。可改用粘贴文字。",
    )
  }

  const rawText = await res.text()
  if (!res.ok) throw mapHttpError(res.status, rawText)

  let parsedApi: { choices?: Array<{ message?: { content?: string } }> }
  try {
    parsedApi = JSON.parse(rawText) as typeof parsedApi
  } catch {
    throw new VlExtractError("parse_error", "通义 VL 返回无法解析，请改用粘贴文字")
  }

  const text = parsedApi.choices?.[0]?.message?.content ?? ""
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new VlExtractError("parse_error", "通义 VL 未返回 JSON，请改用粘贴文字")
  }

  let draftObj: Record<string, unknown>
  try {
    draftObj = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    throw new VlExtractError("parse_error", "通义 VL JSON 解析失败，请改用粘贴文字")
  }

  return {
    mode: "ai",
    draft: normalizeDraft(draftObj),
    source: "screenshot",
    imageCount: compressed.length,
  }
}
