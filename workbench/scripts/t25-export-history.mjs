#!/usr/bin/env node
/**
 * T25 历史聊天记录导出（只读飞书正式表 → 下载附件 → 聊天截图转写 → 汇总 md）
 *
 * 只读：本脚本只调用 lark-cli 的读接口（+field-list、+record-list、+record-download-attachment），
 * 不对飞书表做任何写入。真实表 ID、Base token、模型 key 都从环境变量 / KB_DIR 读取，脚本里不放。
 *
 * 用法（在 workbench/ 目录下，Node >= 22.18）：
 *   node scripts/t25-export-history.mjs stats    --table-id tbl... [--json]
 *   node scripts/t25-export-history.mjs estimate --table-id tbl... [--sample 2] [--work <dir>]
 *   node scripts/t25-export-history.mjs export   --table-id tbl... [--work <dir>] [--concurrency 4]
 *                                                [--limit N] [--record rec...] [--skip-transcribe] [--dry-run]
 *   node scripts/t25-export-history.mjs render   --table-id tbl... [--work <dir>] [--out-dir <dir>]
 *   node scripts/t25-export-history.mjs selftest
 *
 * 环境变量（只写在 .env.local；脚本会自动读 workbench/.env.local）：
 *   LARK_BASE_TOKEN、LARK_CLI_PATH（可选）、LARK_PROD_TABLE_ID（--table-id 的默认值）
 *   KB_DIR（私有知识库根目录，必须在仓库外）、DASHSCOPE_API_KEY、DASHSCOPE_BASE_URL、DASHSCOPE_VL_MODEL
 *
 * 产物：
 *   <KB_DIR>/exports/_t25-work/                  临时目录：下载的截图、逐图转写、断点索引（用完可整目录删）
 *   <KB_DIR>/exports/聊天记录汇总-YYYY-MM-DD.md   汇总（太大时按客户拆成 -01.md、-02.md…，另出索引）
 *
 * 复用：downloadRecordAttachments() 是通用附件下载函数（B 以后也能用）。
 *
 * 隐私：脚本只打印数量和布尔值，不打印聊天内容、客户名和任何凭据。
 */
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import matter from "gray-matter"
import sharp from "sharp"
import {
  OCR_TRANSCRIPT_MARKER,
  VL_TRANSCRIPT_RULE,
  cleanWindowTitle,
  dropTitleTurns,
  failedScreenshotTurn,
  formatScreenshotChat,
  mergeTranscripts,
  parseTranscript,
} from "../src/lib/transcript.ts"

const SCRIPT_DIR = import.meta.dirname
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"])
const NON_CHAT_LABELS = ["报错", "界面", "效果图"]
const REPORT_MAX_CHARS = 300_000 // 单个 md 超过这个字符数就按客户拆文件
const DEFAULT_WORK_NAME = "_t25-work"

const USAGE = `T25 历史聊天记录导出（只读）
  node scripts/t25-export-history.mjs stats    --table-id tbl... [--json]
  node scripts/t25-export-history.mjs estimate --table-id tbl... [--sample 2] [--work <dir>]
  node scripts/t25-export-history.mjs export   --table-id tbl... [--work <dir>] [--concurrency 4] [--limit N] [--record rec...] [--skip-transcribe] [--dry-run]
  node scripts/t25-export-history.mjs render   --table-id tbl... [--work <dir>] [--out-dir <dir>]
  node scripts/t25-export-history.mjs selftest`

// ——— 环境与配置（不打印取值） ————————————————————————————————

/** 读 .env.local（不覆盖已在环境里的值）；只解析 KEY=VALUE。 */
export function loadDotEnv(file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    if (process.env[m[1]] !== undefined) continue
    let v = m[2].trim()
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1)
    }
    process.env[m[1]] = v
  }
}

function loadEnv() {
  loadDotEnv(path.resolve(SCRIPT_DIR, "..", ".env.local"))
  loadDotEnv(path.resolve(process.cwd(), ".env.local"))
}

export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

function readConfig(args) {
  const cfg = {
    cliPath: process.env.LARK_CLI_PATH?.trim() || "lark-cli",
    baseToken: process.env.LARK_BASE_TOKEN?.trim() || "",
    tableId: String(args["table-id"] || process.env.LARK_PROD_TABLE_ID?.trim() || "").trim(),
    kbDir: process.env.KB_DIR?.trim() || "",
    dashscopeKey: process.env.DASHSCOPE_API_KEY?.trim() || "",
    dashscopeBase: (process.env.DASHSCOPE_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, ""),
    vlModel: process.env.DASHSCOPE_VL_MODEL?.trim() || "",
  }
  const missing = []
  if (!cfg.baseToken) missing.push("LARK_BASE_TOKEN")
  if (!cfg.tableId) missing.push("--table-id（或 LARK_PROD_TABLE_ID）")
  if (!cfg.kbDir) missing.push("KB_DIR")
  if (missing.length) throw new Error(`缺少配置：${missing.join("、")}。只写在 .env.local，不要提交。`)
  return cfg
}

function workDir(cfg, args) {
  return path.resolve(String(args.work || path.join(cfg.kbDir, "exports", DEFAULT_WORK_NAME)))
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10)
}

// ——— lark-cli（只读调用） ————————————————————————————————

export function runCli(cliPath, args, { cwd, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cliPath,
      args,
      { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: "utf8", timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err && err.killed) return reject(new Error("lark-cli 超时"))
        if (err) {
          const detail = String(stderr || stdout || err.message).trim().slice(0, 400)
          return reject(new Error(`lark-cli 调用失败：${detail}`))
        }
        resolve(stdout)
      },
    )
  })
}

/** lark-cli 会在 JSON 前后打日志；取最后一个 JSON 对象。 */
export function parseCliJson(text) {
  const t = String(text ?? "").trim()
  if (!t) throw new Error("lark-cli 没有输出")
  try {
    return JSON.parse(t)
  } catch {
    const m = t.match(/\{[\s\S]*\}\s*$/)
    if (!m) throw new Error("lark-cli 输出不是 JSON")
    return JSON.parse(m[0])
  }
}

export function cliErrorText(json) {
  const e = json?.error
  if (e && typeof e === "object") return [e.type, e.subtype, e.message, e.hint].filter(Boolean).join(" / ")
  if (typeof e === "string") return e
  return String(json?.msg || json?.message || "lark-cli error")
}

function assertCliOk(json, what) {
  if (json?.ok === false) throw new Error(`${what}失败：${cliErrorText(json)}`)
  return json
}

/** 字段列表（name/type/选项数量）。只读。 */
export async function listFields({ cliPath, baseToken, tableId }) {
  const stdout = await runCli(cliPath, [
    "base",
    "+field-list",
    "--base-token",
    baseToken,
    "--table-id",
    tableId,
    "--as",
    "user",
    "--format",
    "json",
  ])
  const json = assertCliOk(parseCliJson(stdout), "读取字段列表")
  const fields = json?.data?.fields ?? json?.data?.items ?? []
  if (!Array.isArray(fields) || !fields.length) throw new Error("读取字段列表失败：没有字段")
  return fields.map((f) => ({
    name: String(f.name ?? ""),
    type: String(f.type ?? ""),
    options: Array.isArray(f.options) ? f.options.length : 0,
  }))
}

/** 分页读全部记录（只读）。cells 与 columns 同序。 */
export async function listRecords({ cliPath, baseToken, tableId, pageSize = 200 }) {
  const records = []
  let columns = []
  let offset = 0
  for (;;) {
    const stdout = await runCli(cliPath, [
      "base",
      "+record-list",
      "--base-token",
      baseToken,
      "--table-id",
      tableId,
      "--limit",
      String(pageSize),
      "--offset",
      String(offset),
      "--as",
      "user",
      "--format",
      "json",
    ])
    const json = assertCliOk(parseCliJson(stdout), "读取记录")
    const data = json?.data ?? {}
    if (!Array.isArray(data.data) || !Array.isArray(data.record_id_list)) {
      throw new Error("读取记录失败：返回结构不符（缺少 data.data / record_id_list）")
    }
    if (!columns.length) columns = (data.fields ?? []).map(String)
    data.data.forEach((row, i) => {
      records.push({ recordId: String(data.record_id_list[i] ?? ""), cells: row })
    })
    if (!data.has_more || data.data.length === 0) break
    offset += data.data.length
  }
  return { columns, records }
}

/**
 * 下载一条记录的全部附件（通用函数，B 以后可复用）。
 * lark-cli 要求 --output 是当前目录下的相对路径，所以下载时把 cwd 切到目标目录。
 * 同一条记录里重名文件由 lark-cli 自己加序号；调用方按 file_token 对应。
 */
export async function downloadRecordAttachments({ cliPath, baseToken, tableId, recordId, destDir, timeoutMs, overwrite = true }) {
  await fsp.mkdir(destDir, { recursive: true })
  const args = [
    "base",
    "+record-download-attachment",
    "--base-token",
    baseToken,
    "--table-id",
    tableId,
    "--record-id",
    recordId,
    "--output",
    ".",
    "--as",
    "user",
    "--format",
    "json",
  ]
  if (overwrite) args.splice(args.indexOf("--as"), 0, "--overwrite")
  const stdout = await runCli(cliPath, args, { cwd: destDir, timeoutMs })
  const json = assertCliOk(parseCliJson(stdout), "下载附件")
  const items = json?.data?.downloaded
  if (!Array.isArray(items)) throw new Error("下载附件失败：返回里没有 data.downloaded")
  const files = []
  for (const it of items) {
    const saved = String(it.saved_path ?? "")
    const token = String(it.file_token ?? "")
    if (!saved || !token) throw new Error("下载附件失败：缺少 saved_path / file_token")
    const abs = path.isAbsolute(saved) ? saved : path.join(destDir, saved)
    if (!fs.existsSync(abs)) throw new Error("下载附件失败：文件没落盘")
    files.push({
      token,
      name: String(it.name ?? path.basename(abs)),
      size: Number(it.size_bytes ?? it.size ?? fs.statSync(abs).size),
      savedPath: abs,
    })
  }
  return files
}

// ——— 记录解析（纯函数） ————————————————————————————————

/** 飞书单元格 → 纯文本（保留换行）。 */
export function cellText(v) {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        if (x == null) return ""
        if (typeof x === "string") return x
        if (typeof x === "object") return String(x.text ?? x.name ?? x.link ?? "")
        return String(x)
      })
      .filter(Boolean)
      .join(" ")
  }
  if (typeof v === "object") return String(v.text ?? v.link ?? v.name ?? "")
  return String(v)
}

/** 飞书附件单元格 → {token,name,size} 列表。 */
export function attachmentList(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const it of v) {
    if (!it || typeof it !== "object") continue
    const token = String(it.file_token ?? "")
    if (!token) continue
    out.push({ token, name: String(it.name ?? ""), size: Number(it.size ?? 0) })
  }
  return out
}

export function attachmentKind(name) {
  return IMAGE_EXTS.has(path.extname(String(name || "")).toLowerCase()) ? "image" : "other"
}

export function normalizeNonChatLabel(raw) {
  const s = String(raw ?? "").trim()
  return NON_CHAT_LABELS.includes(s) ? s : "未分类"
}

/** 飞书日期（ISO 带时区）→ YYYY-MM-DD（按 +08:00）。 */
export function dateOnly(iso) {
  const t = Date.parse(String(iso ?? ""))
  if (Number.isNaN(t)) return ""
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10)
}

/**
 * 飞书行 + 本地记录索引 → 导出用的记录对象。
 * columnNames 来自私有 feishu-table.json 的 key→name（D13，不在代码里写死列名）。
 */
export function buildRecordView({ recordId, cells }, columns, columnNames, localIndex) {
  const cell = (key) => {
    const name = columnNames[key]
    if (!name) return null
    const i = columns.findIndex((c) => c.toLowerCase() === String(name).toLowerCase())
    return i >= 0 ? cells[i] : null
  }
  const localId = cellText(cell("local_id")).trim()
  const local = (localId && localIndex.byLocalId.get(localId)) || localIndex.byFeishuId.get(recordId) || null
  return {
    recordId,
    title: cellText(cell("title")).trim(),
    date: dateOnly(cell("date")),
    customer: cellText(cell("customer")).trim(),
    problem: cellText(cell("problem")).trim(),
    solution: cellText(cell("solution")).trim(),
    localId,
    localTranscript: local?.chat || "",
    localFile: local?.file ?? "",
    attachments: attachmentList(cell("attachment")).map((a) => ({ ...a, kind: attachmentKind(a.name) })),
  }
}

// ——— 本地知识库（只读） ————————————————————————————————

/** 本地 records/*.md：local_id、feishu_record_id、原始聊天记录。 */
export async function scanLocalRecords(kbDir) {
  const out = []
  const customersDir = path.join(kbDir, "customers")
  if (!fs.existsSync(customersDir)) return out
  for (const cust of await fsp.readdir(customersDir, { withFileTypes: true })) {
    if (!cust.isDirectory()) continue
    const dir = path.join(customersDir, cust.name, "records")
    if (!fs.existsSync(dir)) continue
    for (const name of await fsp.readdir(dir)) {
      if (!name.endsWith(".md")) continue
      const file = path.join(dir, name)
      let fm
      try {
        fm = matter(await fsp.readFile(file, "utf8"))
      } catch {
        continue
      }
      const d = fm.data || {}
      const m = String(fm.content ?? "").match(/##+\s*原始聊天记录[^\n]*\r?\n([\s\S]*)$/)
      const chat = (m ? m[1] : "")
        .trim()
        .replace(/^`{3,}[^\n]*\n/, "")
        .replace(/\n`{3,}\s*$/, "")
        .trim()
      out.push({
        file,
        localId: String(d.local_id ?? "").trim(),
        feishuRecordId: String(d.feishu_record_id ?? "").trim(),
        title: String(d.title ?? "").trim(),
        date: String(d.date ?? "").slice(0, 10),
        chat,
      })
    }
  }
  return out
}

export function indexLocalRecords(local) {
  const byLocalId = new Map()
  const byFeishuId = new Map()
  for (const r of local) {
    if (r.localId) byLocalId.set(r.localId, r)
    if (r.feishuRecordId) byFeishuId.set(r.feishuRecordId, r)
  }
  return { byLocalId, byFeishuId }
}

async function loadColumnNames(cfg) {
  const file = path.join(cfg.kbDir, "config", "feishu-table.json")
  if (!fs.existsSync(file)) throw new Error("缺少 KB_DIR/config/feishu-table.json（列名映射）")
  const json = JSON.parse(await fsp.readFile(file, "utf8"))
  const map = {}
  for (const col of json?.columns ?? []) {
    if (col && col.key) map[col.key] = String(col.name ?? "")
  }
  return map
}

function attachColumnName(fields, columnNames) {
  const fromType = fields.find((f) => f.type === "attachment")?.name
  if (fromType) return fromType
  const fromConfig = columnNames.attachment
  if (fromConfig && fields.some((f) => f.name === fromConfig)) return fromConfig
  throw new Error("正式表里没有附件字段（type=attachment）")
}

// ——— 价格与用量 ————————————————————————————————

export async function readModelPrices(kbDir) {
  const file = path.join(kbDir, "config", "model-prices.json")
  if (!fs.existsSync(file)) return { ok: false, reason: "没有 config/model-prices.json" }
  try {
    const json = JSON.parse(await fsp.readFile(file, "utf8"))
    return {
      ok: true,
      unit: json?.unit ?? "",
      currency: json?.currency ?? "",
      updatedAt: json?.updatedAt ?? "",
      models: json?.models ?? {},
    }
  } catch {
    return { ok: false, reason: "model-prices.json 解析失败" }
  }
}

export function priceFor(prices, model) {
  if (!prices?.ok) return null
  const models = prices.models || {}
  const keys = Object.keys(models)
  const key = keys.find((k) => k === model) || keys.find((k) => model && (model.includes(k) || k.includes(model)))
  if (!key) return null
  const e = models[key]
  const input = typeof e?.inputPerMillion === "number" ? e.inputPerMillion : null
  const output = typeof e?.outputPerMillion === "number" ? e.outputPerMillion : null
  return { key, input, output, priced: input != null && output != null }
}

export function estimateCost({ promptTokens, completionTokens, price }) {
  if (!price?.priced) return null
  return (promptTokens / 1_000_000) * price.input + (completionTokens / 1_000_000) * price.output
}

// ——— 转写（D19：逐图并行 + 同一条记录按顺序合并去重叠） ————————————————————————————————

export function buildT25Prompt() {
  return [
    "这是微信或飞书的聊天截图。先判断整张图是不是聊天窗口（微信/飞书对话界面）：",
    "- 是：is_chat=true，category 留空，按下面的规则逐字转写；",
    "- 否：is_chat=false，category 填「报错」或「界面」或「效果图」之一，transcript 为空数组，不要硬转。",
    '只输出 JSON：{"is_chat":true,"category":"","window_title":"截图顶部的聊天窗口标题，看不清就留空","transcript":[{"speaker":"昵称","side":"left|right","kind":"speech|time","text":"原文"}]}。',
    VL_TRANSCRIPT_RULE,
    "只转写这一张截图，不要输出客户、问题描述等字段。",
  ].join("")
}

export function mimeOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg"
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png"
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif"
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp"
  return "image/jpeg"
}

/** 与 lib/vl.ts 相同的压缩参数（长边 2048、JPEG 82、1.5MB 软上限）。 */
export async function compressForVl(input) {
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

function vlError(status, body) {
  if (status === 401 || status === 403) return "通义鉴权失败（DASHSCOPE_API_KEY）"
  if (status === 429) return "通义限流（429）"
  if (status === 400 && /unsafe|content|risk|敏感/i.test(body)) return "截图内容被安全策略拒绝"
  return `通义接口返回 ${status}：${String(body).slice(0, 160)}`
}

async function postVl({ key, base, model, image }, timeoutMs = 300_000) {
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
            { type: "text", text: buildT25Prompt() },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(vlError(res.status, text))
  let json
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
  let obj
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

/** 单张图：分类 + 转写（失败返回 ok:false，调用方记录）。 */
export async function transcribeImageFile(file, cfg, { retries = 2 } = {}) {
  const image = await compressForVl(await fsp.readFile(file))
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt))
    const t0 = Date.now()
    try {
      const { obj, usage } = await postVl({ key: cfg.dashscopeKey, base: cfg.dashscopeBase, model: cfg.vlModel, image })
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
      const msg = String(e?.message ?? e)
      if (/鉴权|安全策略|内容被/.test(msg)) break
    }
  }
  return { ok: false, error: String(lastErr?.message ?? lastErr ?? "未知错误"), ms: 0 }
}

/** 固定并发池。 */
export async function runPool(items, limit, worker) {
  const n = Math.max(1, Math.min(Number(limit) || 1, items.length || 1))
  let cursor = 0
  const runners = Array.from({ length: n }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      await worker(items[i], i)
    }
  })
  await Promise.all(runners)
}

// ——— 汇总 md（纯函数） ————————————————————————————————

/** 一条记录：相邻聊天截图合并去重叠；非聊天/失败/非图片插标记行。 */
export function mergeRecordBlocks(blocks) {
  let acc = []
  let prevChat = false
  for (const b of blocks) {
    if (b.kind === "chat") {
      acc = prevChat ? mergeTranscripts(acc, b.turns) : [...acc, ...b.turns]
      prevChat = true
    } else {
      acc = [...acc, ...b.turns]
      prevChat = false
    }
  }
  return acc
}

export function buildChatSection(record, transcriptsByToken) {
  const blocks = []
  const counts = { chat: 0, nonChat: 0, failed: 0, skipped: 0, nonChatLabels: {} }
  record.attachments.forEach((att, i) => {
    const n = i + 1
    if (att.kind !== "image") {
      counts.skipped++
      blocks.push({ kind: "other", turns: [{ speaker: "系统", text: `第 ${n} 张是附件（非图片）：${att.name}`, kind: "speech" }] })
      return
    }
    const t = transcriptsByToken.get(att.token)
    if (!t) {
      counts.failed++
      blocks.push({ kind: "failed", turns: [failedScreenshotTurn(n)] })
      return
    }
    if (!t.ok) {
      counts.failed++
      blocks.push({ kind: "failed", turns: [{ speaker: "系统", text: `第 ${n} 张截图转写失败：${t.error || "未知错误"}`, kind: "speech" }] })
      return
    }
    if (!t.isChat) {
      counts.nonChat++
      const label = normalizeNonChatLabel(t.category)
      counts.nonChatLabels[label] = (counts.nonChatLabels[label] || 0) + 1
      blocks.push({ kind: "nonchat", turns: [{ speaker: "系统", text: `第 ${n} 张为非聊天截图：${label}`, kind: "speech" }] })
      return
    }
    counts.chat++
    blocks.push({ kind: "chat", turns: t.turns || [] })
  })
  const chat = blocks.length ? formatScreenshotChat(mergeRecordBlocks(blocks)) : OCR_TRANSCRIPT_MARKER
  return { chat, counts }
}

export function attachmentSummary(record, counts) {
  const inner = []
  if (counts.chat) inner.push(`聊天截图 ${counts.chat}`)
  if (counts.nonChat) {
    const labels = NON_CHAT_LABELS.filter((l) => counts.nonChatLabels[l]).map((l) => `${l} ${counts.nonChatLabels[l]}`)
    inner.push(`非聊天截图 ${counts.nonChat}（${labels.join("、") || "未分类"}）`)
  }
  if (counts.failed) inner.push(`转写失败 ${counts.failed}`)
  if (counts.skipped) inner.push(`非图片 ${counts.skipped}`)
  return inner.length ? `附件 ${record.attachments.length} 个 · ${inner.join("；")}` : `附件 ${record.attachments.length} 个`
}

export function recordSection(record, seq, transcriptsByToken) {
  const { chat, counts } = buildChatSection(record, transcriptsByToken)
  const lines = []
  lines.push(`#### R${String(seq).padStart(3, "0")} ${record.title || "（无问题名称）"}`)
  lines.push("")
  lines.push(`- 客户：${record.customer || "（空）"}`)
  lines.push(`- 日期：${record.date || "（空）"}`)
  lines.push(`- 本地记录ID：${record.localId || "（无）"}`)
  lines.push(`- 飞书记录ID：${record.recordId}`)
  lines.push(`- ${attachmentSummary(record, counts)}`)
  lines.push("")
  lines.push("##### 问题描述")
  lines.push("")
  lines.push(record.problem || "（飞书为空）")
  lines.push("")
  lines.push("##### 解决方案")
  lines.push("")
  lines.push(record.solution || "（飞书为空）")
  lines.push("")
  lines.push("##### 聊天转写")
  lines.push("")
  if (record.localTranscript) {
    lines.push("（本地记录已有转写，直接合并，未重复转写）")
    lines.push("")
    lines.push("````")
    lines.push(record.localTranscript)
    lines.push("````")
  } else {
    lines.push("````")
    lines.push(chat)
    lines.push("````")
  }
  lines.push("")
  return lines.join("\n")
}

/** 把「按客户分组」的块装进若干文件，每文件不超过 maxChars；客户块不拆开。 */
export function splitIntoParts(blocks, maxChars = REPORT_MAX_CHARS) {
  const parts = []
  let cur = null
  for (const block of blocks) {
    if (cur && cur.size + block.text.length > maxChars) {
      parts.push(cur)
      cur = null
    }
    if (!cur) cur = { size: 0, blocks: [] }
    cur.blocks.push(block)
    cur.size += block.text.length
  }
  if (cur) parts.push(cur)
  return parts
}

export function countDistribution(records) {
  const dist = {}
  for (const r of records) dist[r.attachments.length] = (dist[r.attachments.length] || 0) + 1
  return dist
}

// ——— 命令：stats ————————————————————————————————

async function cmdStats(cfg, args) {
  const fieldList = await listFields(cfg)
  const columnNames = await loadColumnNames(cfg)
  for (const key of ["title", "date", "customer", "problem", "solution"]) {
    if (!columnNames[key]) throw new Error(`私有配置 feishu-table.json 缺少 key=${key}`)
  }
  columnNames.attachment = attachColumnName(fieldList, columnNames)
  const { columns, records } = await listRecords(cfg)
  const localIdName = columnNames.local_id || ""
  const localIdPresent = Boolean(localIdName) && columns.some((c) => c.toLowerCase() === localIdName.toLowerCase())

  const local = await scanLocalRecords(cfg.kbDir)
  const localIndex = indexLocalRecords(local)
  const views = records.map((r) => buildRecordView(r, columns, columnNames, localIndex))
  const withAtt = views.filter((v) => v.attachments.length > 0)
  const attachments = withAtt.reduce((n, v) => n + v.attachments.length, 0)
  const images = withAtt.reduce((n, v) => n + v.attachments.filter((a) => a.kind === "image").length, 0)
  const mergeable = views.filter((v) => v.attachments.length > 0 && v.localTranscript)
  const customers = new Map()
  for (const v of withAtt) customers.set(v.customer || "（未填客户）", (customers.get(v.customer || "（未填客户）") || 0) + 1)

  const missingConfigColumns = ["title", "date", "customer", "problem", "solution", "local_id", "needs"].filter(
    (k) => columnNames[k] && !columns.some((c) => c.toLowerCase() === String(columnNames[k]).toLowerCase()),
  )

  const summary = {
    totalRecords: records.length,
    recordsWithAttachments: withAtt.length,
    attachments,
    images,
    nonImages: attachments - images,
    attachmentCountDistribution: countDistribution(withAtt),
    customersWithAttachments: customers.size,
    customerMaxRecords: Math.max(0, ...customers.values()),
    localRecords: local.length,
    localWithTranscript: local.filter((l) => l.chat).length,
    localIdColumnPresent: localIdPresent,
    mergeableLocalTranscripts: mergeable.length,
    fieldCount: fieldList.length,
    missingConfigColumns,
  }
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2))
    return summary
  }
  console.log("=== T25 统计（只读，正式表） ===")
  console.log(`记录总数：${summary.totalRecords}`)
  console.log(`带附件的记录：${summary.recordsWithAttachments}`)
  console.log(`附件总数：${summary.attachments}（图片 ${summary.images}，非图片 ${summary.nonImages}）`)
  console.log(`单条记录附件数分布：${JSON.stringify(summary.attachmentCountDistribution)}`)
  console.log(`有附件的客户数：${summary.customersWithAttachments}（单客户最多 ${summary.customerMaxRecords} 条）`)
  console.log(`本地记录：${summary.localRecords} 条，有非空「原始聊天记录」${summary.localWithTranscript} 条`)
  console.log(`正式表有「本地记录ID」列：${summary.localIdColumnPresent ? "是" : "否"}`)
  console.log(`本地已有转写可直接合并：${summary.mergeableLocalTranscripts} 条`)
  if (missingConfigColumns.length) console.log(`配置里有、正式表没有的列（key）：${missingConfigColumns.join("、")}`)
  return summary
}

// ——— 命令：export / render ————————————————————————————————

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(data, null, 1), "utf8")
  await fsp.rename(tmp, file)
}

async function loadViews(cfg) {
  const fieldList = await listFields(cfg)
  const columnNames = await loadColumnNames(cfg)
  columnNames.attachment = attachColumnName(fieldList, columnNames)
  const { columns, records } = await listRecords(cfg)
  const missing = ["title", "date", "customer", "problem", "solution"].filter(
    (k) => !columnNames[k] || !columns.some((c) => c.toLowerCase() === columnNames[k].toLowerCase()),
  )
  if (missing.length) throw new Error(`正式表缺少私有配置里的列（key）：${missing.join("、")}`)
  const localIndex = indexLocalRecords(await scanLocalRecords(cfg.kbDir))
  const views = records.map((r) => buildRecordView(r, columns, columnNames, localIndex)).filter((r) => r.attachments.length > 0)
  views.sort((a, b) => a.customer.localeCompare(b.customer, "zh") || a.date.localeCompare(b.date) || a.title.localeCompare(b.title, "zh"))
  views.forEach((r, i) => {
    r.seq = i + 1
  })
  return { views, totalRecords: records.length, columnNames }
}

async function cmdExport(cfg, args) {
  const work = workDir(cfg, args)
  const imagesDir = path.join(work, "images")
  const transcriptsDir = path.join(work, "transcripts")
  const indexFile = path.join(work, "index.json")
  await fsp.mkdir(imagesDir, { recursive: true })
  await fsp.mkdir(transcriptsDir, { recursive: true })

  const { views: allViews, totalRecords } = await loadViews(cfg)
  let views = allViews
  if (args.record) {
    const want = new Set(String(args.record).split(",").map((s) => s.trim()).filter(Boolean))
    views = views.filter((r) => want.has(r.recordId))
  }
  if (args.limit) views = views.slice(0, Number(args.limit) || views.length)
  views.forEach((r, i) => {
    r.seq = i + 1
  })

  const images = views.reduce((n, r) => n + r.attachments.filter((a) => a.kind === "image").length, 0)
  const nonImages = views.reduce((n, r) => n + r.attachments.filter((a) => a.kind !== "image").length, 0)
  console.log(`导出范围：${views.length} 条记录（正式表共 ${totalRecords} 条，无附件 ${totalRecords - allViews.length} 条不导出）`)
  console.log(`附件：${images + nonImages} 个（图片 ${images}，非图片 ${nonImages}）`)
  console.log(`临时目录：KB_DIR/exports/${args.work ? path.basename(work) : DEFAULT_WORK_NAME}`)
  if (args["dry-run"]) {
    console.log("dry-run：不下载、不转写。")
    return
  }

  // 1) 下载（断点续传）
  const index = readJson(indexFile, { records: {} })
  const needDownload = []
  for (const r of views) {
    const prev = index.records[r.recordId]
    const ok = prev && prev.attachments?.length === r.attachments.length && prev.attachments.every((a) => fs.existsSync(path.join(work, a.file)))
    if (ok) r.attachments = prev.attachments.map((a, i) => ({ ...r.attachments[i], ...a }))
    else needDownload.push(r)
  }
  const failedRecords = new Set()
  if (needDownload.length) {
    console.log(`下载附件：${needDownload.length} 条记录…`)
    let done = 0
    await runPool(needDownload, Number(args["download-concurrency"] || 3), async (r) => {
      const dest = path.join(imagesDir, r.recordId)
      try {
        await fsp.rm(dest, { recursive: true, force: true })
        await fsp.mkdir(dest, { recursive: true })
        const files = await downloadRecordAttachments({
          cliPath: cfg.cliPath,
          baseToken: cfg.baseToken,
          tableId: cfg.tableId,
          recordId: r.recordId,
          destDir: dest,
        })
        const byToken = new Map(files.map((f) => [f.token, f]))
        for (const [i, att] of r.attachments.entries()) {
          const f = byToken.get(att.token)
          if (!f) throw new Error("少下载了一个附件（token 不在返回里）")
          const ext = path.extname(f.name).toLowerCase() || path.extname(f.savedPath).toLowerCase() || ".bin"
          const fileName = `${String(i + 1).padStart(2, "0")}-${att.token}${ext}`
          const target = path.join(dest, fileName)
          if (path.resolve(f.savedPath) !== path.resolve(target)) await fsp.rename(f.savedPath, target)
          att.file = path.relative(work, target).split(path.sep).join("/")
          att.savedBytes = f.size
        }
        index.records[r.recordId] = {
          seq: r.seq,
          attachments: r.attachments.map((a) => ({ token: a.token, name: a.name, kind: a.kind, file: a.file, size: a.size })),
        }
        await writeJsonAtomic(indexFile, index)
      } catch (e) {
        failedRecords.add(r.recordId)
        console.error(`  记录 ${r.recordId} 下载失败：${e?.message || e}`)
      }
      done++
      if (done % 10 === 0 || done === needDownload.length) console.log(`  已处理 ${done}/${needDownload.length}`)
    })
    console.log(`下载完成：成功 ${needDownload.length - failedRecords.size}，失败 ${failedRecords.size}`)
  } else {
    console.log("下载：已全部存在，跳过")
  }

  // 2) 转写（断点续传；本地已有转写的记录不重复转写）
  const jobs = []
  for (const r of views) {
    if (r.localTranscript || failedRecords.has(r.recordId)) continue
    const missingFiles = r.attachments.filter((a) => a.kind === "image" && !fs.existsSync(path.join(work, a.file || "")))
    if (missingFiles.length) {
      failedRecords.add(r.recordId)
      continue
    }
    r.attachments.forEach((a, i) => {
      if (a.kind !== "image") return
      const tFile = path.join(transcriptsDir, `${a.token}.json`)
      if (fs.existsSync(tFile) && !args.force) return
      jobs.push({ record: r, att: a, n: i + 1, tFile })
    })
  }
  console.log(`待转写图片：${jobs.length} 张（已完成/本地已有的跳过）`)
  if (jobs.length && !args["skip-transcribe"]) {
    if (!cfg.dashscopeKey) throw new Error("缺少 DASHSCOPE_API_KEY，无法转写")
    const usageFile = path.join(work, "usage.jsonl")
    let done = 0
    let fail = 0
    const t0 = Date.now()
    const failedImages = []
    await runPool(jobs, Number(args.concurrency || 4), async (job) => {
      const result = await transcribeImageFile(path.join(work, job.att.file), cfg)
      await writeJsonAtomic(job.tFile, {
        token: job.att.token,
        recordId: job.record.recordId,
        seq: job.record.seq,
        imageIndex: job.n,
        model: cfg.vlModel,
        at: new Date().toISOString(),
        ...result,
      })
      if (!result.ok) {
        fail++
        failedImages.push({ recordId: job.record.recordId, seq: job.record.seq, imageIndex: job.n, error: result.error })
      }
      await fsp.appendFile(
        usageFile,
        JSON.stringify({
          at: new Date().toISOString(),
          recordId: job.record.recordId,
          token: job.att.token,
          model: cfg.vlModel,
          ok: result.ok,
          promptTokens: result.usage?.promptTokens ?? 0,
          completionTokens: result.usage?.completionTokens ?? 0,
          imageTokens: result.usage?.imageTokens ?? 0,
          ms: result.ms,
        }) + "\n",
        "utf8",
      )
      done++
      if (done % 10 === 0 || done === jobs.length) {
        console.log(`  已转写 ${done}/${jobs.length}（失败 ${fail}），用时 ${Math.round((Date.now() - t0) / 1000)}s`)
      }
    })
    console.log(`转写完成：${jobs.length} 张，失败 ${fail} 张`)
    if (failedImages.length) {
      const file = path.join(work, "failed.json")
      await writeJsonAtomic(file, failedImages)
      console.log(`失败明细（记录号/图序/原因）已写到 ${path.relative(work, file)}`)
      for (const f of failedImages.slice(0, 20)) console.log(`  R${String(f.seq).padStart(3, "0")} 第 ${f.imageIndex} 张：${f.error}`)
    }
  }

  // 3) 渲染
  await cmdRender(cfg, args, { work, views, excludedNoAttachment: totalRecords - allViews.length })
}

function buildSummarySection(views, transcriptsMap, extras) {
  const stats = { chat: 0, nonChat: 0, failed: 0 }
  const perCustomer = new Map()
  for (const r of views) {
    const { counts } = buildChatSection(r, transcriptsMap)
    stats.chat += counts.chat
    stats.nonChat += counts.nonChat
    stats.failed += counts.failed
    const key = r.customer || "（未填客户）"
    const it = perCustomer.get(key) || { records: 0, images: 0, chat: 0, nonChat: 0 }
    it.records++
    it.images += r.attachments.filter((a) => a.kind === "image").length
    it.chat += counts.chat
    it.nonChat += counts.nonChat
    perCustomer.set(key, it)
  }
  const attTotal = views.reduce((n, r) => n + r.attachments.length, 0)
  const imgTotal = views.reduce((n, r) => n + r.attachments.filter((a) => a.kind === "image").length, 0)
  const lines = []
  lines.push("# 历史聊天记录汇总")
  lines.push("")
  lines.push(`> 只读导出：飞书正式表里带附件的记录，共 ${views.length} 条、${attTotal} 个附件（图片 ${imgTotal}）。`)
  lines.push("> 截图用通义 VL 逐张并行转写（D19），同一条记录的相邻截图按顺序合并去重叠；非聊天截图只标注，不转写。")
  lines.push("> 截图原件在 KB_DIR/exports/_t25-work/images/，用完可整个目录删掉。")
  lines.push("")
  lines.push("## 统计汇总")
  lines.push("")
  lines.push("| 项目 | 数量 |")
  lines.push("| --- | --- |")
  lines.push(`| 记录数（带附件） | ${views.length} |`)
  lines.push(`| 附件数 | ${attTotal} |`)
  lines.push(`| 图片数 | ${imgTotal} |`)
  lines.push(`| 聊天截图 | ${stats.chat} |`)
  lines.push(`| 非聊天截图 | ${stats.nonChat} |`)
  lines.push(`| 转写失败 | ${stats.failed} |`)
  if (extras.localMerged) lines.push(`| 本地已有转写直接合并 | ${extras.localMerged} |`)
  if (extras.excludedNoAttachment) lines.push(`| 未导出（无附件） | ${extras.excludedNoAttachment} |`)
  lines.push("")
  lines.push("## 按客户分布")
  lines.push("")
  lines.push("| 客户 | 记录数 | 图片数 | 聊天截图 | 非聊天截图 |")
  lines.push("| --- | --- | --- | --- | --- |")
  for (const [cust, it] of [...perCustomer.entries()].sort((a, b) => b[1].records - a[1].records || a[0].localeCompare(b[0], "zh"))) {
    lines.push(`| ${cust} | ${it.records} | ${it.images} | ${it.chat} | ${it.nonChat} |`)
  }
  lines.push("")
  lines.push("## 单条记录附件数分布")
  lines.push("")
  lines.push("| 附件数 | 记录数 |")
  lines.push("| --- | --- |")
  for (const [n, c] of Object.entries(countDistribution(views)).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    lines.push(`| ${n} | ${c} |`)
  }
  lines.push("")
  return lines.join("\n")
}

async function loadTranscripts(work, views) {
  const dir = path.join(work, "transcripts")
  const map = new Map()
  for (const r of views) {
    for (const a of r.attachments) {
      if (a.kind !== "image") continue
      const t = readJson(path.join(dir, `${a.token}.json`), null)
      if (t) map.set(a.token, t)
    }
  }
  return map
}

async function cmdRender(cfg, args, ctx) {
  const work = ctx?.work ?? workDir(cfg, args)
  const views = ctx?.views ?? (await loadViews(cfg)).views
  const excludedNoAttachment = ctx?.excludedNoAttachment ?? Number(args["excluded-no-attachment"] || 0)
  const transcripts = await loadTranscripts(work, views)
  const localMerged = views.filter((r) => r.localTranscript).length
  const header = buildSummarySection(views, transcripts, { excludedNoAttachment, localMerged })

  const blocks = []
  let cur = null
  for (const r of views) {
    const key = r.customer || "（未填客户）"
    if (!cur || cur.customer !== key) {
      cur = { customer: key, records: [], text: "" }
      blocks.push(cur)
    }
    cur.records.push(r)
    cur.text += recordSection(r, r.seq, transcripts)
  }

  const outDir = path.resolve(String(args["out-dir"] || path.join(cfg.kbDir, "exports")))
  await fsp.mkdir(outDir, { recursive: true })
  const base = `聊天记录汇总-${String(args.date || todayStamp())}`
  const totalChars = header.length + blocks.reduce((n, b) => n + b.text.length, 0)
  const parts = splitIntoParts(blocks)
  const written = []
  if (parts.length <= 1 && totalChars <= REPORT_MAX_CHARS) {
    const file = path.join(outDir, `${base}.md`)
    await fsp.writeFile(file, `${header}${blocks.map((b) => b.text).join("")}`, "utf8")
    written.push(file)
  } else {
    const indexFile = path.join(outDir, `${base}.md`)
    const lines = [header, "## 明细文件", ""]
    parts.forEach((p, i) => {
      const name = `${base}-${String(i + 1).padStart(2, "0")}.md`
      lines.push(`- [${name}](${name})：${p.blocks.map((b) => b.customer).join("、")}`)
    })
    lines.push("")
    await fsp.writeFile(indexFile, lines.join("\n"), "utf8")
    written.push(indexFile)
    for (const [i, p] of parts.entries()) {
      const name = `${base}-${String(i + 1).padStart(2, "0")}.md`
      const file = path.join(outDir, name)
      await fsp.writeFile(file, [`# ${base}（第 ${i + 1}/${parts.length} 部分）`, "", ...p.blocks.map((b) => b.text)].join("\n"), "utf8")
      written.push(file)
    }
  }
  console.log(`已写出 ${written.length} 个文件：`)
  for (const f of written) console.log(`  ${path.basename(f)}（${Math.round(fs.statSync(f).size / 1024)} KB）`)
  return written
}

// ——— 命令：estimate ————————————————————————————————

async function cmdEstimate(cfg, args) {
  const work = workDir(cfg, args)
  const sampleRoot = path.join(work, "_sample")
  const { views } = await loadViews(cfg)
  const imageViews = views.filter((r) => r.attachments.some((a) => a.kind === "image"))
  const totalImages = imageViews.reduce((n, r) => n + r.attachments.filter((a) => a.kind === "image").length, 0)
  const n = Math.max(1, Number(args.sample || 2))
  const picks = []
  for (let i = 0; i < Math.min(n, imageViews.length); i++) {
    const r = imageViews[Math.floor((i * imageViews.length) / Math.min(n, imageViews.length))]
    const imgs = r.attachments.filter((a) => a.kind === "image")
    picks.push({ record: r, att: imgs[Math.floor(imgs.length / 2)] })
  }

  const prices = await readModelPrices(cfg.kbDir)
  const price = priceFor(prices, cfg.vlModel)
  let promptTokens = 0
  let completionTokens = 0
  let imageTokens = 0
  let ms = 0
  for (const [i, p] of picks.entries()) {
    const dest = path.join(sampleRoot, p.record.recordId)
    await fsp.rm(dest, { recursive: true, force: true })
    const files = await downloadRecordAttachments({ ...cfg, recordId: p.record.recordId, destDir: dest })
    const f = files.find((x) => x.token === p.att.token)
    if (!f) throw new Error("抽样下载失败：找不到对应附件")
    const r = await transcribeImageFile(f.savedPath, cfg)
    if (!r.ok) throw new Error(`抽样转写失败：${r.error}`)
    promptTokens += r.usage.promptTokens
    completionTokens += r.usage.completionTokens
    imageTokens += r.usage.imageTokens
    ms += r.ms
    console.log(`样本 ${i + 1}：${r.ms}ms，输入 ${r.usage.promptTokens} tokens（图 ${r.usage.imageTokens}），输出 ${r.usage.completionTokens}，是聊天截图=${r.isChat}`)
  }
  const avgPrompt = promptTokens / picks.length
  const avgCompletion = completionTokens / picks.length
  const totalPrompt = Math.round(avgPrompt * totalImages)
  const totalCompletion = Math.round(avgCompletion * totalImages)
  const cost = price?.priced ? estimateCost({ promptTokens: totalPrompt, completionTokens: totalCompletion, price }) : null
  const concurrency = Number(args.concurrency || 4)
  const avgMs = ms / picks.length
  console.log("=== 费用与耗时估算 ===")
  console.log(`图片总数：${totalImages}（抽样 ${picks.length} 张）`)
  console.log(`平均每张：输入 ${Math.round(avgPrompt)}（其中图片 ${Math.round(imageTokens / picks.length)}）、输出 ${Math.round(avgCompletion)} tokens，耗时 ${Math.round(avgMs)}ms`)
  console.log(`预计总量：输入 ${totalPrompt}、输出 ${totalCompletion} tokens`)
  if (prices?.ok) console.log(`单价来源：KB_DIR/config/model-prices.json（${prices.updatedAt}，${prices.unit}）`)
  else console.log(`单价来源：不可用（${prices?.reason || "未知"}）`)
  if (price) console.log(`模型在配置里的条目：${price.key}，输入单价=${price.input ?? "空"}，输出单价=${price.output ?? "空"}`)
  else console.log("模型在配置里没有条目")
  console.log(cost == null ? "预计费用：无法计算（配置里这个模型的单价为空，需用户核实）" : `预计费用：${cost.toFixed(2)} ${prices.currency || "元"}`)
  console.log(`预计耗时：单张均值 ${Math.round(avgMs)}ms，并发 ${concurrency} → 约 ${Math.ceil((avgMs * totalImages) / concurrency / 1000 / 60)} 分钟（转写，不含下载）`)
  return { totalImages, avgPrompt, avgCompletion, totalPrompt, totalCompletion, cost, price }
}

// ——— 自测（纯函数，无真实数据） ————————————————————————————————

function assert(cond, msg) {
  if (!cond) throw new Error(`selftest 失败：${msg}`)
}

export function selftest() {
  assert(attachmentKind("a.PNG") === "image", "PNG 是图片")
  assert(attachmentKind("a.pdf") === "other", "PDF 不是图片")
  assert(normalizeNonChatLabel("报错") === "报错", "报错标签")
  assert(normalizeNonChatLabel("随便") === "未分类", "未知标签归一")
  assert(dateOnly("2026-03-13T17:55:51.000+08:00") === "2026-03-13", "日期按 +08:00")
  assert(cellText([{ text: "a" }, "b"]) === "a b", "单元格拼接")

  const turns = (arr) => arr.map(([speaker, text]) => ({ speaker, text, kind: "speech" }))
  const merged = mergeRecordBlocks([
    { kind: "chat", turns: turns([["客户", "A"], ["我", "B"]]) },
    { kind: "chat", turns: turns([["我", "B"], ["客户", "C"]]) },
    { kind: "nonchat", turns: [{ speaker: "系统", text: "第 3 张为非聊天截图：报错", kind: "speech" }] },
    { kind: "chat", turns: turns([["我", "B"], ["客户", "C"]]) },
  ])
  assert(merged.length === 6, `相邻截图去重叠：期望 6 条，实际 ${merged.length}`)
  assert(merged.filter((t) => t.text === "B").length === 2, "非相邻的不去重")

  const chat = formatScreenshotChat(turns([["客户", "你好"], ["我", "收到"]]))
  assert(chat.startsWith(OCR_TRANSCRIPT_MARKER), "转写首行是 OCR 标记")
  assert(chat.includes("客户：你好"), "转写格式")

  const record = {
    recordId: "recX",
    title: "标题",
    date: "2026-01-01",
    customer: "客户A",
    problem: "p",
    solution: "s",
    localId: "",
    localTranscript: "",
    attachments: [
      { token: "t1", name: "a.png", kind: "image" },
      { token: "t2", name: "b.pdf", kind: "other" },
      { token: "t3", name: "c.png", kind: "image" },
    ],
  }
  const tmap = new Map([
    ["t1", { ok: true, isChat: true, turns: turns([["客户", "X"]]) }],
    ["t3", { ok: true, isChat: false, category: "报错", turns: [] }],
  ])
  const sec = buildChatSection(record, tmap)
  assert(sec.counts.chat === 1 && sec.counts.nonChat === 1 && sec.counts.skipped === 1, "附件计数")
  assert(sec.chat.includes("第 2 张是附件（非图片）"), "非图片标注")
  assert(sec.chat.includes("第 3 张为非聊天截图：报错"), "非聊天截图标注")

  const parts = splitIntoParts(
    [
      { customer: "A", text: "x".repeat(40) },
      { customer: "B", text: "x".repeat(40) },
      { customer: "C", text: "x".repeat(40) },
    ],
    100,
  )
  assert(parts.length === 2, "按客户拆文件")
  assert(parts[0].blocks.length === 2, "客户块不拆开")

  const dist = countDistribution([{ attachments: [1, 2] }, { attachments: [1] }, { attachments: [1] }])
  assert(dist[2] === 1 && dist[1] === 2, "附件数分布")

  const price = priceFor({ ok: true, models: { m: { inputPerMillion: 2, outputPerMillion: 8 } } }, "m")
  assert(price.priced, "读取单价")
  assert(estimateCost({ promptTokens: 1_000_000, completionTokens: 1_000_000, price }) === 10, "费用计算")
  assert(priceFor({ ok: true, models: { m: { inputPerMillion: null, outputPerMillion: null } } }, "m").priced === false, "单价为空时不算钱")

  const parsed = parseCliJson('INFO noise\n{"ok":true,"data":{"downloaded":[]}}')
  assert(parsed.ok === true, "解析 lark-cli 输出")
  console.log("selftest 通过")
}

// ——— 入口 ————————————————————————————————

async function main() {
  loadEnv()
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] || "help"
  if (cmd === "selftest") return selftest()
  if (cmd === "help" || args.help) {
    console.log(USAGE)
    return
  }
  const cfg = readConfig(args)
  if (cmd === "stats") return cmdStats(cfg, args)
  if (cmd === "estimate") return cmdEstimate(cfg, args)
  if (cmd === "export") return cmdExport(cfg, args)
  if (cmd === "render") return cmdRender(cfg, args)
  throw new Error(`未知命令：${cmd}\n${USAGE}`)
}

if (import.meta.filename === path.resolve(process.argv[1] || "")) {
  main().catch((e) => {
    console.error(`错误：${e?.message || e}`)
    process.exitCode = 1
  })
}
