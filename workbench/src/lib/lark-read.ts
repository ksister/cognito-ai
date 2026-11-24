import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import matter from "gray-matter"

/**
 * Read-only lark-cli access shared by the T25 export script, the T26 snapshot
 * script and the replay API routes (one copy — do not fork this into scripts/).
 *
 * This module must stay importable from a plain Node script, so:
 *  - no `import "server-only"` (Next-only guard would throw outside Next),
 *  - relative runtime imports carry the `.ts` suffix (Node type stripping needs it),
 *  - nothing is written to Feishu here; only `+field-list`, `+record-list`
 *    and `+record-download-attachment`.
 */

export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"])

export type LarkTarget = {
  /** Resolved lark-cli binary. */
  cliPath: string
  baseToken: string
  tableId: string
}

const WORKBUDDY_CLI_FALLBACK = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  ".workbuddy",
  "binaries",
  "node",
  "cli-connector-packages",
  "node_modules",
  "@larksuite",
  "cli",
  "bin",
  process.platform === "win32" ? "lark-cli.exe" : "lark-cli",
)

/**
 * LARK_CLI_PATH → PATH → WorkBuddy fallback (same order as lark-bitable.ts,
 * but without the server-only import so scripts can use it too).
 */
export function resolveCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LARK_CLI_PATH?.trim()
  if (configured && fs.existsSync(configured)) return configured
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""]
  for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, `lark-cli${ext}`)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  if (WORKBUDDY_CLI_FALLBACK && fs.existsSync(WORKBUDDY_CLI_FALLBACK)) return WORKBUDDY_CLI_FALLBACK
  return configured || "lark-cli"
}

// ——— lark-cli（只读调用） ————————————————————————————————

export function runCli(cliPath: string, args: string[], { cwd, timeoutMs = 180_000 }: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
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
export function parseCliJson(text: string): unknown {
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

export function cliErrorText(json: unknown): string {
  const e = (json as { error?: unknown } | null)?.error
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>
    return [o.type, o.subtype, o.message, o.hint].filter(Boolean).join(" / ")
  }
  if (typeof e === "string") return e
  const j = json as { msg?: unknown; message?: unknown } | null
  return String(j?.msg || j?.message || "lark-cli error")
}

function assertCliOk(json: unknown, what: string): Record<string, unknown> {
  if ((json as { ok?: boolean } | null)?.ok === false) throw new Error(`${what}失败：${cliErrorText(json)}`)
  return json as Record<string, unknown>
}

export type LarkField = { name: string; type: string; options: number }

/** 字段列表（name/type/选项数量）。只读。 */
export async function listFeishuFields({ cliPath, baseToken, tableId }: LarkTarget): Promise<LarkField[]> {
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
  const json = assertCliOk(parseCliJson(stdout), "读取字段列表") as {
    data?: { fields?: Record<string, unknown>[]; items?: Record<string, unknown>[] }
  }
  const fields = json?.data?.fields ?? json?.data?.items ?? []
  if (!Array.isArray(fields) || !fields.length) throw new Error("读取字段列表失败：没有字段")
  return fields.map((f) => ({
    name: String(f.name ?? ""),
    type: String(f.type ?? ""),
    options: Array.isArray(f.options) ? f.options.length : 0,
  }))
}

export type LarkRow = { recordId: string; cells: unknown[] }

/** 分页读全部记录（只读）。cells 与 columns 同序。 */
export async function listFeishuRecords({
  cliPath,
  baseToken,
  tableId,
  pageSize = 200,
}: LarkTarget & { pageSize?: number }): Promise<{ columns: string[]; records: LarkRow[] }> {
  const records: LarkRow[] = []
  let columns: string[] = []
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
    const json = assertCliOk(parseCliJson(stdout), "读取记录") as {
      data?: { data?: unknown[]; record_id_list?: unknown[]; fields?: unknown[]; has_more?: boolean }
    }
    const data = json?.data ?? {}
    if (!Array.isArray(data.data) || !Array.isArray(data.record_id_list)) {
      throw new Error("读取记录失败：返回结构不符（缺少 data.data / record_id_list）")
    }
    if (!columns.length) columns = (data.fields ?? []).map(String)
    data.data.forEach((row, i) => {
      records.push({ recordId: String(data.record_id_list?.[i] ?? ""), cells: row as unknown[] })
    })
    if (!data.has_more || data.data.length === 0) break
    offset += data.data.length
  }
  return { columns, records }
}

/**
 * 下载一条记录的全部附件（通用函数）。
 * lark-cli 要求 --output 是当前目录下的相对路径，所以下载时把 cwd 切到目标目录。
 * 同一条记录里重名文件由 lark-cli 自己加序号；调用方按 file_token 对应。
 */
export async function downloadRecordAttachments({
  cliPath,
  baseToken,
  tableId,
  recordId,
  destDir,
  timeoutMs,
  overwrite = true,
}: LarkTarget & { recordId: string; destDir: string; timeoutMs?: number; overwrite?: boolean }): Promise<
  { token: string; name: string; size: number; savedPath: string }[]
> {
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
  const json = assertCliOk(parseCliJson(stdout), "下载附件") as {
    data?: { downloaded?: Record<string, unknown>[] }
  }
  const items = json?.data?.downloaded
  if (!Array.isArray(items)) throw new Error("下载附件失败：返回里没有 data.downloaded")
  const files: { token: string; name: string; size: number; savedPath: string }[] = []
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
export function cellText(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        if (x == null) return ""
        if (typeof x === "string") return x
        if (typeof x === "object") {
          const o = x as { text?: unknown; name?: unknown; link?: unknown }
          return String(o.text ?? o.name ?? o.link ?? "")
        }
        return String(x)
      })
      .filter(Boolean)
      .join(" ")
  }
  if (typeof v === "object") {
    const o = v as { text?: unknown; link?: unknown; name?: unknown }
    return String(o.text ?? o.link ?? o.name ?? "")
  }
  return String(v)
}

export type AttachmentInfo = { token: string; name: string; size: number; kind: "image" | "other" }

/** 飞书附件单元格 → {token,name,size,kind} 列表。 */
export function attachmentList(v: unknown): AttachmentInfo[] {
  if (!Array.isArray(v)) return []
  const out: AttachmentInfo[] = []
  for (const it of v) {
    if (!it || typeof it !== "object") continue
    const o = it as { file_token?: unknown; name?: unknown; size?: unknown }
    const token = String(o.file_token ?? "")
    if (!token) continue
    const name = String(o.name ?? "")
    out.push({ token, name, size: Number(o.size ?? 0), kind: attachmentKind(name) })
  }
  return out
}

export function attachmentKind(name: string): "image" | "other" {
  return IMAGE_EXTS.has(path.extname(String(name || "")).toLowerCase()) ? "image" : "other"
}

/** 飞书日期（ISO 带时区）→ YYYY-MM-DD（按 +08:00）。 */
export function dateOnly(iso: unknown): string {
  const t = Date.parse(String(iso ?? ""))
  if (Number.isNaN(t)) return ""
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10)
}

export type TableRecordView = {
  recordId: string
  title: string
  date: string
  customer: string
  problem: string
  solution: string
  localId: string
  localTranscript: string
  localFile: string
  attachments: AttachmentInfo[]
  /** T27：表结构配置里的全部字段（key → 文本），左右对比用；日期已转成 YYYY-MM-DD。 */
  fields: Record<string, string>
}

/**
 * 飞书行 + 本地记录索引 → 导出用的记录对象。
 * columnNames 来自私有 feishu-table.json 的 key→name（D13，不在代码里写死列名）。
 */
export function buildRecordView(
  row: LarkRow,
  columns: string[],
  columnNames: Record<string, string>,
  localIndex: { byLocalId: Map<string, LocalRecordInfo>; byFeishuId: Map<string, LocalRecordInfo> },
): TableRecordView {
  const cell = (key: string): unknown => {
    const name = columnNames[key]
    if (!name) return null
    const i = columns.findIndex((c) => c.toLowerCase() === String(name).toLowerCase())
    return i >= 0 ? row.cells[i] : null
  }
  const fields: Record<string, string> = {}
  for (const key of Object.keys(columnNames)) {
    if (!key || key === "attachment") continue
    fields[key] = key === "date" ? dateOnly(cell(key)) : cellText(cell(key)).trim()
  }
  const localId = cellText(cell("local_id")).trim()
  const local = (localId && localIndex.byLocalId.get(localId)) || localIndex.byFeishuId.get(row.recordId) || null
  return {
    recordId: row.recordId,
    title: cellText(cell("title")).trim(),
    date: dateOnly(cell("date")),
    customer: cellText(cell("customer")).trim(),
    problem: cellText(cell("problem")).trim(),
    solution: cellText(cell("solution")).trim(),
    localId,
    localTranscript: local?.chat || "",
    localFile: local?.file ?? "",
    attachments: attachmentList(cell("attachment")),
    fields,
  }
}

// ——— 本地知识库（只读） ————————————————————————————————

export type LocalRecordInfo = {
  file: string
  localId: string
  feishuRecordId: string
  title: string
  date: string
  chat: string
}

/** 本地 records/*.md：local_id、feishu_record_id、原始聊天记录。 */
export async function scanLocalRecords(kbDir: string): Promise<LocalRecordInfo[]> {
  const out: LocalRecordInfo[] = []
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

export function indexLocalRecords(local: LocalRecordInfo[]): {
  byLocalId: Map<string, LocalRecordInfo>
  byFeishuId: Map<string, LocalRecordInfo>
} {
  const byLocalId = new Map<string, LocalRecordInfo>()
  const byFeishuId = new Map<string, LocalRecordInfo>()
  for (const r of local) {
    if (r.localId) byLocalId.set(r.localId, r)
    if (r.feishuRecordId) byFeishuId.set(r.feishuRecordId, r)
  }
  return { byLocalId, byFeishuId }
}

/** 私有 KB_DIR/config/feishu-table.json 的 key→列名。 */
export async function loadColumnNames(kbDir: string): Promise<Record<string, string>> {
  const file = path.join(kbDir, "config", "feishu-table.json")
  if (!fs.existsSync(file)) throw new Error("缺少 KB_DIR/config/feishu-table.json（列名映射）")
  const json = JSON.parse(await fsp.readFile(file, "utf8")) as { columns?: { key?: string; name?: string }[] }
  const map: Record<string, string> = {}
  for (const col of json?.columns ?? []) {
    if (col && col.key) map[col.key] = String(col.name ?? "")
  }
  return map
}

/** 附件列：优先按字段类型找，其次按配置里的名字找。 */
export function attachColumnName(fields: LarkField[], columnNames: Record<string, string>): string {
  const fromType = fields.find((f) => f.type === "attachment")?.name
  if (fromType) return fromType
  const fromConfig = columnNames.attachment
  if (fromConfig && fields.some((f) => f.name === fromConfig)) return fromConfig
  throw new Error("正式表里没有附件字段（type=attachment）")
}

/**
 * 只读指纹：用于证明「刷新快照没有改飞书」（前后对比）。
 * 只输出哈希，不含任何客户数据。
 */
export function rowsFingerprint(rows: LarkRow[]): string {
  const sorted = [...rows].map((r) => `${r.recordId}\u0000${JSON.stringify(r.cells)}`).sort()
  return createHash("sha256").update(sorted.join("\u0001")).digest("hex").slice(0, 16)
}
