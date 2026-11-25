import fsp from "node:fs/promises"
import sharp from "sharp"
import {
  VL_TRANSCRIPT_RULE,
  VL_TRANSCRIPT_RULE_V2,
  VL_TRANSCRIPT_RULE_V3,
  cleanWindowTitle,
  dropTitleTurns,
  parseTranscript,
} from "./transcript.ts"
import type { TranscriptTurn } from "./types"

/**
 * 单张截图的通义 VL 转写（D19：一图一次调用，只做转写和「是不是聊天截图」）。
 * 从 T25 导出脚本里抽出来，T25 与 T26 回放快照共用这一份。
 *
 * 提示词版本：
 *  - v1（`buildSnapshotTranscriptPrompt`）：主流程、T25、T26 快照用，保持不变；
 *  - v2（`buildTranscriptPromptV2`）：曾经的回放版本，会把自动翻译小字拆成消息，已弃用；
 *  - v3（`buildTranscriptPromptV3`）：回放用 = v1 原文 + 三条判断侧别的规则（看头像、看气泡颜色、连续消息归属）。
 *
 * Script-safe: no `server-only`, `.ts` suffix on relative runtime imports.
 */

/** 提示词版本写进每次回放结果，比较两批结果时要能看出来用的是哪一版。 */
export const TRANSCRIPT_PROMPT_VERSION_V1 = "transcript-v1"
export const TRANSCRIPT_PROMPT_VERSION_V2 = "transcript-v2"
export const TRANSCRIPT_PROMPT_VERSION_V3 = "transcript-v3"

export const NON_CHAT_LABELS = ["报错", "界面", "效果图"] as const

export type VlConfig = { dashscopeKey: string; dashscopeBase: string; vlModel: string }

export type TranscribeResult =
  | {
      ok: true
      isChat: boolean
      category: string
      windowTitle: string
      turns: TranscriptTurn[]
      usage: { promptTokens: number; completionTokens: number; imageTokens: number }
      ms: number
      jpegBytes: number
      attempts: number
    }
  | { ok: false; error: string; ms: number }

export function normalizeNonChatLabel(raw: unknown): string {
  const s = String(raw ?? "").trim()
  return (NON_CHAT_LABELS as readonly string[]).includes(s) ? s : "未分类"
}

function chatPrompt(rule: string): string {
  return [
    "这是微信或飞书的聊天截图。先判断整张图是不是聊天窗口（微信/飞书对话界面）：",
    "- 是：is_chat=true，category 留空，按下面的规则逐字转写；",
    "- 否：is_chat=false，category 填「报错」或「界面」或「效果图」之一，transcript 为空数组，不要硬转。",
    '只输出 JSON：{"is_chat":true,"category":"","window_title":"截图顶部的聊天窗口标题，看不清就留空","transcript":[{"speaker":"昵称","side":"left|right","kind":"speech|time","text":"原文"}]}。',
    rule,
    "只转写这一张截图，不要输出客户、问题描述等字段。",
  ].join("")
}

export function buildSnapshotTranscriptPrompt(): string {
  return chatPrompt(VL_TRANSCRIPT_RULE)
}

/** v3 转写提示词（回放用）：v1 原文 + 三条判断侧别的规则，其余一个字不改。 */
export function buildTranscriptPromptV3(): string {
  return chatPrompt(VL_TRANSCRIPT_RULE_V3)
}

/**
 * v2 转写提示词（只在回放里用）：
 * 多给一份「我的昵称」清单，让模型把右侧的人认成用户本人；昵称一律照抄截图原文。
 */
export function buildTranscriptPromptV2({ myNicknames = [] }: { myNicknames?: string[] } = {}): string {
  const mine = myNicknames.map((n) => String(n).trim()).filter(Boolean)
  const mineText = mine.length
    ? `用户在聊天里的昵称可能是：${mine.join("、")}（截图里出现这些名字的消息，气泡通常在右侧）。`
    : ""
  return [
    "这是微信或飞书的聊天截图。先判断整张图是不是聊天窗口（微信/飞书对话界面）：",
    "- 是：is_chat=true，category 留空，按下面的规则逐字转写；",
    "- 否：is_chat=false，category 填「报错」或「界面」或「效果图」之一，transcript 为空数组，不要硬转。",
    '只输出 JSON：{"is_chat":true,"category":"","window_title":"截图顶部的聊天窗口标题，看不清就留空","transcript":[{"speaker":"昵称","side":"left|right","kind":"speech|time","text":"原文"}]}。',
    mineText,
    VL_TRANSCRIPT_RULE_V2,
    "只转写这一张截图，不要输出客户、问题描述等字段。",
  ].join("")
}

export function mimeOf(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg"
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png"
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif"
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp"
  return "image/jpeg"
}

/** 与 lib/vl.ts 相同的压缩参数（长边 2048、JPEG 82、1.5MB 软上限）。 */
export async function compressForVl(input: Buffer): Promise<Buffer> {
  try {
    const img = sharp(input, { animated: false }).rotate()
    const meta = await img.metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    let out = img
    if (w > 2048 || h > 2048) {
      out = out.resize({
        width: w >= h ? 2048 : undefined,
        height: h > w ? 2048 : undefined,
        fit: "inside",
        withoutEnlargement: true,
      })
    }
    let buf = await out.jpeg({ quality: 82, mozjpeg: true }).toBuffer()
    if (buf.length > 1_500_000) buf = await sharp(buf).jpeg({ quality: 62, mozjpeg: true }).toBuffer()
    return buf
  } catch {
    return input
  }
}

function vlError(status: number, body: string): string {
  if (status === 401 || status === 403) return "通义鉴权失败（DASHSCOPE_API_KEY）"
  if (status === 429) return "通义限流（429）"
  if (status === 400 && /unsafe|content|risk|敏感/i.test(body)) return "截图内容被安全策略拒绝"
  return `通义接口返回 ${status}：${String(body).slice(0, 160)}`
}

async function postVl(
  { key, base, model, image, prompt }: { key: string; base: string; model: string; image: Buffer; prompt: string },
  timeoutMs = 300_000,
) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      enable_thinking: false,
      max_tokens: 32768,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeOf(image)};base64,${image.toString("base64")}` } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(vlError(res.status, text))
  let json: {
    choices?: { finish_reason?: string; message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { image_tokens?: number } }
  }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error("通义返回不是 JSON")
  }
  const choice = json?.choices?.[0]
  if (choice?.finish_reason === "length") throw new Error("输出被截断（这张图聊天太长）")
  const content = String(choice?.message?.content ?? "")
  const m = content.match(/\{[\s\S]*\}/)
  if (!m) throw new Error("通义没有返回 JSON")
  let obj: { is_chat?: unknown; isChat?: unknown; category?: unknown; window_title?: unknown; transcript?: unknown }
  try {
    obj = JSON.parse(m[0])
  } catch {
    throw new Error("通义返回的 JSON 解析失败")
  }
  const usage = json?.usage ?? {}
  return {
    obj,
    usage: {
      promptTokens: Number(usage.prompt_tokens ?? 0),
      completionTokens: Number(usage.completion_tokens ?? 0),
      imageTokens: Number(usage?.prompt_tokens_details?.image_tokens ?? 0),
    },
  }
}

/** 单张图：分类 + 转写（失败返回 ok:false，调用方记录）。prompt 默认 v1。 */
export async function transcribeImageFile(
  file: string,
  cfg: VlConfig,
  { retries = 2, prompt = buildSnapshotTranscriptPrompt() }: { retries?: number; prompt?: string } = {},
): Promise<TranscribeResult> {
  const image = await compressForVl(await fsp.readFile(file))
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt))
    const t0 = Date.now()
    try {
      const { obj, usage } = await postVl({
        key: cfg.dashscopeKey,
        base: cfg.dashscopeBase,
        model: cfg.vlModel,
        image,
        prompt,
      })
      const isChat = obj?.is_chat === true || obj?.isChat === true
      const windowTitle = cleanWindowTitle(typeof obj?.window_title === "string" ? obj.window_title : "")
      const turns = dropTitleTurns(parseTranscript(obj?.transcript, { me: "我", contact: "客户" }), windowTitle)
      return {
        ok: true,
        isChat,
        category: isChat ? "" : normalizeNonChatLabel(obj?.category),
        windowTitle,
        turns: isChat ? turns : [],
        usage,
        ms: Date.now() - t0,
        jpegBytes: image.length,
        attempts: attempt + 1,
      }
    } catch (e) {
      lastErr = e
      const msg = String((e as Error)?.message ?? e)
      if (/鉴权|安全策略|内容被/.test(msg)) break
    }
  }
  return { ok: false, error: String((lastErr as Error)?.message ?? lastErr ?? "未知错误"), ms: 0 }
}
