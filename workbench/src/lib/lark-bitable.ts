import "server-only"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  attachmentFieldId,
  buildCreateFields,
  schemaHasWritableFieldId,
  type FeishuTableSchema,
} from "./feishu-schema"
import { readFeishuTableSchema } from "./feishu-schema-load"
import type { RecordDraft } from "./types"

/** Field IDs for 技术支持表格 — locked by DoD */
export const LARK_FIELDS = {
  company: "fldSRNwM7M", // 客户公司1 (select)
  contact: "fldIce3Lrd", // 客户/联系人 (text)
  title: "fldsEte5ol", // 问题名称
  problem: "fldIEXM1tY", // 问题描述（表无「AI 问题描述」）
  product: "fldRTpNF2w", // 软件版本 (select)
  resolveMethod: "fldD4Dmdci", // 解决方式 (select)
  status: "fldv0cGqr1", // 处理状态 (select)
  handlers: "fldR5MJ3au", // 处理人 (person)
  attachment: "fld4TZSFx8", // 附件补充 — ONLY via update/upload-attachment
  solution: "fldxhpmYNW", // 解决方案
  process: "fldz7BYNqS", // 排查过程
  supportType: "flde0WYnqJ", // 支持类型
  site: "fldO0HoEtn", // 项目/现场
} as const

export const FALLBACK_OTHER_COMPANY = "其他-待确认"

export type LarkHandler = { name: string; open_id: string }

export type LarkSelectOptions = {
  company: string[]
  status: string[]
  product: string[]
  resolveMethod: string[]
  supportType: string[]
  site: string[]
}

export type LarkPushStep =
  | "local"
  | "create"
  | "upload"
  | "attach"
  | "config"
  | "auth"
  | "cli"

export type LarkPushResult = {
  ok: boolean
  recordId?: string
  steps: { step: LarkPushStep; ok: boolean; message?: string }[]
  warnings: string[]
  error?: string
  code?: string | number
  mode?: "cli" | "api"
}

export type LarkPushInput = {
  draft: RecordDraft
  /** Selected Feishu 客户公司1 option; if empty, derived from draft.customer */
  companyOption?: string
  handlerOpenIds?: string[]
  /** Preferred: already-saved jpg paths under customers/.../files/ */
  screenshotFiles?: { name: string; path: string }[]
  /** API-mode fallback buffers (optional if paths provided) */
  screenshots?: { name: string; data: Buffer }[]
}

type LarkCfg = {
  appId?: string
  appSecret?: string
  userAccessToken?: string
  refreshToken?: string
  baseToken: string
  tableId: string
  pushMode: "cli" | "api"
  cliPath?: string
}

const OPEN = "https://open.feishu.cn/open-apis"

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

function missingLarkTarget(cfg: LarkCfg): string | null {
  if (cfg.baseToken && cfg.tableId) return null
  return "未配置 LARK_BASE_TOKEN 或 LARK_TABLE_ID。请写入 .env.local（.env.example 只有占位符）。本地记录已保留，可用「复制为飞书行」降级。"
}

function readCfg(): LarkCfg {
  const modeRaw = (process.env.LARK_PUSH_MODE ?? "cli").trim().toLowerCase()
  return {
    appId: process.env.LARK_APP_ID?.trim() || undefined,
    appSecret: process.env.LARK_APP_SECRET?.trim() || undefined,
    userAccessToken: process.env.LARK_USER_ACCESS_TOKEN?.trim() || undefined,
    refreshToken: process.env.LARK_REFRESH_TOKEN?.trim() || undefined,
    baseToken: process.env.LARK_BASE_TOKEN?.trim() ?? "",
    tableId: process.env.LARK_TABLE_ID?.trim() ?? "",
    pushMode: modeRaw === "api" ? "api" : "cli",
    cliPath: process.env.LARK_CLI_PATH?.trim() || undefined,
  }
}

export function parseHandlersEnv(): LarkHandler[] {
  const raw = process.env.LARK_HANDLERS?.trim()
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .map((h) => ({
        name: String((h as LarkHandler)?.name ?? "").trim(),
        open_id: String((h as LarkHandler)?.open_id ?? "").trim(),
      }))
      .filter((h) => h.open_id.startsWith("ou_"))
  } catch {
    return []
  }
}

export function hasLarkUserToken(): boolean {
  return Boolean(process.env.LARK_USER_ACCESS_TOKEN?.trim())
}

export function getLarkPushMode(): "cli" | "api" {
  return readCfg().pushMode
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function whichOnPath(bin: string): Promise<string | null> {
  const isWin = process.platform === "win32"
  const cmd = isWin ? "where.exe" : "which"
  return new Promise((resolve) => {
    const child = spawn(cmd, isWin ? [bin] : [bin], {
      shell: false,
      windowsHide: true,
      env: process.env,
    })
    let out = ""
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8")
    })
    child.on("error", () => resolve(null))
    child.on("close", (code) => {
      if (code !== 0) return resolve(null)
      const first = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean)
      resolve(first || null)
    })
  })
}

/** Resolve lark-cli binary: LARK_CLI_PATH → PATH → WorkBuddy fallback */
export async function resolveLarkCli(): Promise<{ path?: string; error?: string }> {
  const cfg = readCfg()
  if (cfg.cliPath) {
    if (await fileExists(cfg.cliPath)) return { path: cfg.cliPath }
    return {
      error: `LARK_CLI_PATH 指向的文件不存在：${cfg.cliPath}`,
    }
  }
  const fromPath =
    (await whichOnPath("lark-cli")) ||
    (process.platform === "win32" ? await whichOnPath("lark-cli.exe") : null)
  if (fromPath) return { path: fromPath }

  if (WORKBUDDY_CLI_FALLBACK && (await fileExists(WORKBUDDY_CLI_FALLBACK))) {
    return { path: WORKBUDDY_CLI_FALLBACK }
  }

  return {
    error:
      "未找到 lark-cli。请安装：npx @larksuite/cli@latest install，然后执行 lark-cli config init / 登录（--as user）。也可设置 LARK_CLI_PATH。本地已保存，可用「复制为飞书行」降级。",
  }
}

type CliRunResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  json: Record<string, unknown> | null
}

function parseCliJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // Prefer last JSON object in output (CLI may print noise)
  const candidates: string[] = []
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed)
  const match = trimmed.match(/\{[\s\S]*\}\s*$/)
  if (match) candidates.push(match[0])
  for (const c of candidates) {
    try {
      return JSON.parse(c) as Record<string, unknown>
    } catch {
      /* try next */
    }
  }
  return null
}

async function runLarkCli(cliPath: string, args: string[]): Promise<CliRunResult> {
  return new Promise((resolve) => {
    const child = spawn(cliPath, args, {
      shell: false,
      windowsHide: true,
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8")
    })
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8")
    })
    child.on("error", (err) => {
      resolve({
        exitCode: null,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
        json: null,
      })
    })
    child.on("close", (code) => {
      const combined = stdout.trim() ? stdout : stderr
      resolve({
        exitCode: code,
        stdout,
        stderr,
        json: parseCliJson(combined),
      })
    })
  })
}

function cliErrorMessage(run: CliRunResult): { message: string; code: string | number } {
  const j = run.json
  if (j) {
    const ok = j.ok
    const err = j.error as Record<string, unknown> | string | undefined
    if (ok === false || err) {
      if (err && typeof err === "object") {
        const subtype = String(err.subtype ?? "")
        const type = String(err.type ?? "")
        const msg = String(err.message ?? err.hint ?? "lark-cli error")
        const hint = err.hint ? `（${String(err.hint)}）` : ""
        if (type === "config" || subtype === "not_configured") {
          return {
            message: `lark-cli 未配置/未登录：${msg}${hint}。请运行 lark-cli config init 并完成 OAuth（--as user）。`,
            code: "cli_not_configured",
          }
        }
        const code = (err.code as string | number | undefined) ?? (subtype || type || "cli_error")
        return { message: `${msg}${hint}`, code }
      }
      if (typeof err === "string") return { message: err, code: "cli_error" }
    }
    if (typeof j.code === "number" && j.code !== 0) {
      return { message: String(j.msg ?? j.message ?? "lark-cli API error"), code: j.code }
    }
    if (typeof j.code === "string" && j.code && j.code !== "0") {
      return { message: String(j.msg ?? j.message ?? "lark-cli error"), code: j.code }
    }
  }
  const tail = (run.stderr || run.stdout || "lark-cli failed").trim().slice(0, 500)
  return { message: tail || "lark-cli failed", code: run.exitCode ?? "cli_error" }
}

function isCliSuccess(run: CliRunResult): boolean {
  if (run.json) {
    if (run.json.ok === false) return false
    // OpenAPI-shaped embedded code
    if (typeof run.json.code === "number" && run.json.code !== 0) return false
    // Explicit Feishu biz codes that must never look like success
    const code = run.json.code
    if (code === 800030005 || code === "800030005") return false
    const errObj = run.json.error as { code?: unknown } | undefined
    if (errObj && (errObj.code === 800030005 || errObj.code === "800030005")) return false
    if (run.json.ok === true) return true
    // Some CLI commands return data without ok:true
    if (run.json.data != null && run.exitCode === 0) return true
  }
  return run.exitCode === 0 && !run.json?.error
}

async function withTempJsonFile<T>(payload: unknown, fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lark-cli-"))
  const filePath = path.join(dir, "payload.json")
  try {
    await fs.writeFile(filePath, JSON.stringify(payload), { encoding: "utf8" })
    return await fn(filePath)
  } finally {
    try {
      await fs.unlink(filePath)
    } catch {
      /* ignore */
    }
    try {
      await fs.rmdir(dir)
    } catch {
      /* ignore */
    }
  }
}

type FieldMeta = {
  field_id: string
  field_name: string
  type: number
  property?: { options?: { name: string; id?: string }[] }
}

function optionsOf(fields: FieldMeta[], fieldId: string): string[] {
  const f = fields.find((x) => x.field_id === fieldId)
  return (f?.property?.options ?? []).map((o) => o.name).filter(Boolean)
}

function extractFieldItems(json: Record<string, unknown> | null): FieldMeta[] {
  if (!json) return []
  const data = (json.data as Record<string, unknown> | undefined) ?? json
  const items =
    (data.items as FieldMeta[] | undefined) ||
    (data.fields as FieldMeta[] | undefined) ||
    (json.items as FieldMeta[] | undefined) ||
    []
  return Array.isArray(items) ? items : []
}

function extractRecordId(json: Record<string, unknown> | null): string | undefined {
  if (!json) return undefined
  const data = (json.data as Record<string, unknown> | undefined) ?? json
  const list =
    (data.record_id_list as string[] | undefined) ||
    (json.record_id_list as string[] | undefined) ||
    []
  if (Array.isArray(list) && list[0]) return String(list[0])
  const records =
    (data.records as { record_id?: string }[] | undefined) ||
    (json.records as { record_id?: string }[] | undefined) ||
    []
  if (Array.isArray(records) && records[0]?.record_id) return String(records[0].record_id)
  if (typeof data.record_id === "string") return data.record_id
  if (typeof json.record_id === "string") return json.record_id
  return undefined
}

async function fetchFieldMetaViaCli(cliPath: string, cfg: LarkCfg): Promise<FieldMeta[]> {
  const run = await runLarkCli(cliPath, [
    "base",
    "+field-list",
    "--base-token",
    cfg.baseToken,
    "--table-id",
    cfg.tableId,
    "--as",
    "user",
    "--format",
    "json",
  ])
  if (!isCliSuccess(run)) {
    const e = cliErrorMessage(run)
    throw Object.assign(new Error(e.message), { code: e.code })
  }
  return extractFieldItems(run.json)
}

/** Field names and select options from lark-cli. Used only to refresh config options. */
export async function listFeishuFieldOptions(): Promise<
  { ok: true; fields: { name: string; options: string[] }[] } | { ok: false; error: string }
> {
  const cfg = readCfg()
  const missing = missingLarkTarget(cfg)
  if (missing) return { ok: false, error: missing }
  if (cfg.pushMode !== "cli") {
    return { ok: false, error: "同步选项只走 lark-cli。请把 LARK_PUSH_MODE 设为 cli（默认）。" }
  }
  const resolved = await resolveLarkCli()
  if (!resolved.path) return { ok: false, error: resolved.error || "未找到 lark-cli" }
  try {
    const fields = await fetchFieldMetaViaCli(resolved.path, cfg)
    return {
      ok: true,
      fields: fields.map((f) => ({
        name: f.field_name,
        options: (f.property?.options ?? []).map((o) => o.name).filter(Boolean),
      })),
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * CLI batch-create JSON (lark-cli 1.0.x help):
 * {"fields":["fld…",…],"rows":[[cell,…]]}
 * select → string; person → [{"id":"ou_…"}]; never include attachment.
 */
function toCliBatchPayload(fields: Record<string, unknown>): {
  fields: string[]
  rows: unknown[][]
} {
  const safe = { ...fields }
  delete safe[LARK_FIELDS.attachment]
  const keys = Object.keys(safe)
  const row = keys.map((k) => safe[k])
  return { fields: keys, rows: [row] }
}

async function batchCreateViaCli(
  cliPath: string,
  cfg: LarkCfg,
  fields: Record<string, unknown>,
): Promise<{ recordId: string } | { error: string; code: string | number }> {
  const payload = toCliBatchPayload(fields)
  return withTempJsonFile(payload, async (tmp) => {
    const run = await runLarkCli(cliPath, [
      "base",
      "+record-batch-create",
      "--base-token",
      cfg.baseToken,
      "--table-id",
      cfg.tableId,
      "--json",
      `@${tmp}`,
      "--as",
      "user",
      "--format",
      "json",
    ])
    // If @file unsupported, retry with inline JSON string (spawn argv, no shell)
    let used = run
    if (!isCliSuccess(run) && /json|@|file|parse|invalid/i.test(cliErrorMessage(run).message)) {
      used = await runLarkCli(cliPath, [
        "base",
        "+record-batch-create",
        "--base-token",
        cfg.baseToken,
        "--table-id",
        cfg.tableId,
        "--json",
        JSON.stringify(payload),
        "--as",
        "user",
        "--format",
        "json",
      ])
    }
    if (!isCliSuccess(used)) {
      const e = cliErrorMessage(used)
      // Never treat 800030005 as success — already gated in isCliSuccess
      return { error: e.message, code: e.code }
    }
    const recordId = extractRecordId(used.json)
    if (!recordId) return { error: "batch_create 未返回 record_id（请检查 lark-cli 输出）", code: "no_record_id" }
    return { recordId }
  })
}

async function uploadAttachmentsViaCli(
  cliPath: string,
  cfg: LarkCfg,
  recordId: string,
  fieldId: string,
  files: { name: string; path: string }[],
): Promise<{ ok: true } | { error: string; code: string | number }> {
  if (!files.length) return { ok: true }
  const args = [
    "base",
    "+record-upload-attachment",
    "--base-token",
    cfg.baseToken,
    "--table-id",
    cfg.tableId,
    "--record-id",
    recordId,
    "--field-id",
    fieldId,
  ]
  for (const f of files) {
    args.push("--file", f.path)
  }
  args.push("--as", "user", "--format", "json")
  const run = await runLarkCli(cliPath, args)
  if (!isCliSuccess(run)) {
    const e = cliErrorMessage(run)
    return { error: e.message, code: e.code }
  }
  return { ok: true }
}

function emptyOptions(): LarkSelectOptions {
  return {
    company: [],
    status: [],
    product: [],
    resolveMethod: [],
    supportType: [],
    site: [],
  }
}

function optionsFromFields(fields: FieldMeta[]): LarkSelectOptions {
  return {
    company: optionsOf(fields, LARK_FIELDS.company),
    status: optionsOf(fields, LARK_FIELDS.status),
    product: optionsOf(fields, LARK_FIELDS.product),
    resolveMethod: optionsOf(fields, LARK_FIELDS.resolveMethod),
    supportType: optionsOf(fields, LARK_FIELDS.supportType),
    site: optionsOf(fields, LARK_FIELDS.site),
  }
}

export { buildCreateFields } from "./feishu-schema"

const NO_FIELD_ID_MESSAGE =
  "飞书表结构配置里没有可写入的 fieldId。本地记录已保留。请用「复制为飞书行」；cli/api 建行需要在私有 feishu-table.json 里填写 fieldId（不要提交到仓库）。"

function missingWritableFieldId(schema: FeishuTableSchema): string | null {
  return schemaHasWritableFieldId(schema) ? null : NO_FIELD_ID_MESSAGE
}

function resolveAttachFieldId(schema: FeishuTableSchema, warnings: string[]): string {
  const fromSchema = attachmentFieldId(schema)
  if (fromSchema) return fromSchema
  warnings.push("附件列未在配置里写 fieldId，上传仍使用代码中的附件字段 ID。若不是该列，请在私有配置里填写。")
  return LARK_FIELDS.attachment
}

// ——— Optional OpenAPI Bearer fallback (LARK_PUSH_MODE=api) ———

/** In-memory refreshed user token for this process only — never logged. */
let cachedUserToken: { token: string; expMs: number } | null = null

async function refreshUserAccessToken(cfg: LarkCfg): Promise<string | null> {
  if (!cfg.appId || !cfg.appSecret || !cfg.refreshToken) return null
  const res = await fetch(`${OPEN}/authen/v1/oidc/refresh_access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken,
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
    }),
  })
  const data = (await res.json()) as {
    code?: number
    msg?: string
    data?: { access_token?: string; expires_in?: number; refresh_token?: string }
  }
  if (data.code !== 0 || !data.data?.access_token) return null
  const expiresIn = data.data.expires_in ?? 7200
  cachedUserToken = {
    token: data.data.access_token,
    expMs: Date.now() + Math.max(60, expiresIn - 120) * 1000,
  }
  return data.data.access_token
}

async function getUserAccessToken(cfg: LarkCfg): Promise<{ token?: string; error?: string }> {
  if (cachedUserToken && cachedUserToken.expMs > Date.now()) {
    return { token: cachedUserToken.token }
  }
  if (cfg.userAccessToken) {
    return { token: cfg.userAccessToken }
  }
  const refreshed = await refreshUserAccessToken(cfg)
  if (refreshed) return { token: refreshed }
  return {
    error:
      "API 模式缺少飞书用户凭证：请设置 LARK_USER_ACCESS_TOKEN，或 LARK_REFRESH_TOKEN + LARK_APP_ID + LARK_APP_SECRET。默认请改回 LARK_PUSH_MODE=cli（lark-cli OAuth）。",
  }
}

type LarkApiJson = {
  code: number
  msg: string
  data?: Record<string, unknown>
}

async function larkFetch(
  token: string,
  url: string,
  init: RequestInit & { query?: Record<string, string> } = {},
): Promise<LarkApiJson> {
  const u = new URL(url)
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) u.searchParams.set(k, v)
  }
  const { query, ...rest } = init
  void query
  const res = await fetch(u, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(rest.body && !(rest.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(rest.headers ?? {}),
    },
  })
  return (await res.json()) as LarkApiJson
}

async function fetchFieldMetaApi(token: string, cfg: LarkCfg): Promise<FieldMeta[]> {
  const items: FieldMeta[] = []
  let pageToken: string | undefined
  do {
    const json = await larkFetch(
      token,
      `${OPEN}/bitable/v1/apps/${cfg.baseToken}/tables/${cfg.tableId}/fields`,
      {
        method: "GET",
        query: pageToken ? { page_token: pageToken, page_size: "100" } : { page_size: "100" },
      },
    )
    if (json.code !== 0) throw Object.assign(new Error(json.msg || "list fields failed"), { code: json.code })
    const data = json.data as { items?: FieldMeta[]; page_token?: string; has_more?: boolean }
    items.push(...(data.items ?? []))
    pageToken = data.has_more ? data.page_token : undefined
  } while (pageToken)
  return items
}

async function batchCreateApi(
  token: string,
  cfg: LarkCfg,
  fields: Record<string, unknown>,
): Promise<{ recordId: string } | { error: string; code: number }> {
  const safe = { ...fields }
  delete safe[LARK_FIELDS.attachment]
  const json = await larkFetch(
    token,
    `${OPEN}/bitable/v1/apps/${cfg.baseToken}/tables/${cfg.tableId}/records/batch_create`,
    {
      method: "POST",
      query: { user_id_type: "open_id" },
      body: JSON.stringify({ records: [{ fields: safe }] }),
    },
  )
  if (json.code !== 0) {
    return { error: json.msg || "batch_create failed", code: json.code }
  }
  const data = json.data as { records?: { record_id?: string }[] }
  const recordId = data.records?.[0]?.record_id
  if (!recordId) return { error: "batch_create 未返回 record_id", code: json.code }
  return { recordId }
}

async function uploadMediaApi(
  token: string,
  cfg: LarkCfg,
  fileName: string,
  data: Buffer,
): Promise<{ file_token: string; name: string } | { error: string; code: number }> {
  const form = new FormData()
  form.append("file_name", fileName)
  form.append("parent_type", "bitable_image")
  form.append("parent_node", cfg.baseToken)
  form.append("size", String(data.length))
  form.append("file", new File([new Uint8Array(data)], fileName, { type: "image/jpeg" }))

  const res = await fetch(`${OPEN}/drive/v1/medias/upload_all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const json = (await res.json()) as LarkApiJson & {
    data?: { file_token?: string }
  }
  if (json.code !== 0 || !json.data?.file_token) {
    return { error: json.msg || "upload_all failed", code: json.code ?? -1 }
  }
  return { file_token: json.data.file_token, name: fileName }
}

async function updateAttachmentApi(
  token: string,
  cfg: LarkCfg,
  recordId: string,
  fieldId: string,
  files: { file_token: string; name: string }[],
): Promise<{ ok: true } | { error: string; code: number }> {
  const json = await larkFetch(
    token,
    `${OPEN}/bitable/v1/apps/${cfg.baseToken}/tables/${cfg.tableId}/records/${recordId}`,
    {
      method: "PUT",
      query: { user_id_type: "open_id" },
      body: JSON.stringify({
        fields: {
          [fieldId]: files.map((f) => ({
            file_token: f.file_token,
            name: f.name,
          })),
        },
      }),
    },
  )
  if (json.code !== 0) {
    return { error: json.msg || "update attachment failed", code: json.code }
  }
  return { ok: true }
}

export async function getLarkMeta(): Promise<{
  configured: boolean
  error?: string
  code?: string | number
  options: LarkSelectOptions
  handlers: LarkHandler[]
  baseToken: string
  tableId: string
  mode: "cli" | "api"
  cliPath?: string
}> {
  const cfg = readCfg()
  const handlers = parseHandlersEnv()
  const empty = emptyOptions()
  const missing = missingLarkTarget(cfg)
  if (missing) {
    return {
      configured: false,
      error: missing,
      code: "lark_base_unconfigured",
      options: empty,
      handlers,
      baseToken: cfg.baseToken,
      tableId: cfg.tableId,
      mode: cfg.pushMode,
    }
  }

  if (cfg.pushMode === "cli") {
    const resolved = await resolveLarkCli()
    if (!resolved.path) {
      return {
        configured: false,
        error: resolved.error,
        code: "cli_missing",
        options: empty,
        handlers,
        baseToken: cfg.baseToken,
        tableId: cfg.tableId,
        mode: "cli",
      }
    }
    try {
      const fields = await fetchFieldMetaViaCli(resolved.path, cfg)
      return {
        configured: true,
        options: optionsFromFields(fields),
        handlers,
        baseToken: cfg.baseToken,
        tableId: cfg.tableId,
        mode: "cli",
        cliPath: resolved.path,
      }
    } catch (e) {
      const err = e as Error & { code?: string | number }
      return {
        configured: false,
        error: err.message,
        code: err.code,
        options: empty,
        handlers,
        baseToken: cfg.baseToken,
        tableId: cfg.tableId,
        mode: "cli",
        cliPath: resolved.path,
      }
    }
  }

  // API mode
  const auth = await getUserAccessToken(cfg)
  if (!auth.token) {
    return {
      configured: false,
      error: auth.error,
      options: empty,
      handlers,
      baseToken: cfg.baseToken,
      tableId: cfg.tableId,
      mode: "api",
    }
  }
  try {
    const fields = await fetchFieldMetaApi(auth.token, cfg)
    return {
      configured: true,
      options: optionsFromFields(fields),
      handlers,
      baseToken: cfg.baseToken,
      tableId: cfg.tableId,
      mode: "api",
    }
  } catch (e) {
    const err = e as Error & { code?: number }
    return {
      configured: false,
      error: err.message,
      code: err.code,
      options: empty,
      handlers,
      baseToken: cfg.baseToken,
      tableId: cfg.tableId,
      mode: "api",
    }
  }
}

async function resolveScreenshotFiles(
  input: LarkPushInput,
): Promise<{ name: string; path: string }[]> {
  if (input.screenshotFiles?.length) {
    const out: { name: string; path: string }[] = []
    for (const f of input.screenshotFiles) {
      if (await fileExists(f.path)) out.push(f)
    }
    return out
  }
  return []
}

async function pushViaCli(input: LarkPushInput, cfg: LarkCfg, schema: FeishuTableSchema): Promise<LarkPushResult> {
  const steps: LarkPushResult["steps"] = [{ step: "local", ok: true, message: "本地已落盘" }]
  const warnings: string[] = []

  const noFieldId = missingWritableFieldId(schema)
  if (noFieldId) {
    steps.push({ step: "config", ok: false, message: noFieldId })
    return { ok: false, steps, warnings, error: noFieldId, code: "schema_no_field_id", mode: "cli" }
  }

  const resolved = await resolveLarkCli()
  if (!resolved.path) {
    steps.push({ step: "cli", ok: false, message: resolved.error })
    return {
      ok: false,
      steps,
      warnings,
      error: resolved.error,
      code: "cli_missing",
      mode: "cli",
    }
  }

  try {
    await fetchFieldMetaViaCli(resolved.path, cfg)
  } catch (e) {
    const err = e as Error & { code?: string | number }
    steps.push({ step: "auth", ok: false, message: err.message })
    return { ok: false, steps, warnings, error: err.message, code: err.code ?? "meta_failed", mode: "cli" }
  }

  const createFields = buildCreateFields(
    input.draft,
    schema,
    input.companyOption,
    input.handlerOpenIds,
    warnings,
  )

  const created = await batchCreateViaCli(resolved.path, cfg, createFields)
  if ("error" in created) {
    steps.push({ step: "create", ok: false, message: `${created.error} (${created.code})` })
    return {
      ok: false,
      steps,
      warnings,
      error: `建行失败：${created.error}`,
      code: created.code,
      mode: "cli",
    }
  }
  steps.push({ step: "create", ok: true, message: created.recordId })

  const files = await resolveScreenshotFiles(input)
  if (!files.length) {
    return { ok: true, recordId: created.recordId, steps, warnings, mode: "cli" }
  }

  const up = await uploadAttachmentsViaCli(
    resolved.path,
    cfg,
    created.recordId,
    resolveAttachFieldId(schema, warnings),
    files,
  )
  if ("error" in up) {
    steps.push({ step: "attach", ok: false, message: `${up.error} (${up.code})` })
    return {
      ok: false,
      recordId: created.recordId,
      steps,
      warnings: [
        ...warnings,
        "建行已成功但附件上传失败，请到飞书表格手动补附件，或用「复制为飞书行」降级",
      ],
      error: `附件上传失败：${up.error}`,
      code: up.code,
      mode: "cli",
    }
  }
  steps.push({ step: "upload", ok: true, message: `${files.length} 张` })
  steps.push({ step: "attach", ok: true })
  return { ok: true, recordId: created.recordId, steps, warnings, mode: "cli" }
}

async function pushViaApi(input: LarkPushInput, cfg: LarkCfg, schema: FeishuTableSchema): Promise<LarkPushResult> {
  const steps: LarkPushResult["steps"] = [{ step: "local", ok: true, message: "本地已落盘" }]
  const warnings: string[] = []

  const noFieldId = missingWritableFieldId(schema)
  if (noFieldId) {
    steps.push({ step: "config", ok: false, message: noFieldId })
    return { ok: false, steps, warnings, error: noFieldId, code: "schema_no_field_id", mode: "api" }
  }

  const auth = await getUserAccessToken(cfg)
  if (!auth.token) {
    steps.push({ step: "config", ok: false, message: auth.error })
    return { ok: false, steps, warnings, error: auth.error, code: "missing_credentials", mode: "api" }
  }

  try {
    await fetchFieldMetaApi(auth.token, cfg)
  } catch (e) {
    const err = e as Error & { code?: number }
    steps.push({ step: "auth", ok: false, message: err.message })
    return { ok: false, steps, warnings, error: err.message, code: err.code ?? "meta_failed", mode: "api" }
  }

  const createFields = buildCreateFields(
    input.draft,
    schema,
    input.companyOption,
    input.handlerOpenIds,
    warnings,
  )

  const created = await batchCreateApi(auth.token, cfg, createFields)
  if ("error" in created) {
    steps.push({ step: "create", ok: false, message: `${created.error} (${created.code})` })
    return {
      ok: false,
      steps,
      warnings,
      error: `建行失败：${created.error}`,
      code: created.code,
      mode: "api",
    }
  }
  steps.push({ step: "create", ok: true, message: created.recordId })

  // Prefer disk files; fall back to in-memory buffers for API mode
  const disk = await resolveScreenshotFiles(input)
  const shots: { name: string; data: Buffer }[] = []
  if (disk.length) {
    for (const f of disk) {
      shots.push({ name: f.name, data: await fs.readFile(f.path) })
    }
  } else {
    shots.push(...(input.screenshots ?? []))
  }

  if (!shots.length) {
    return { ok: true, recordId: created.recordId, steps, warnings, mode: "api" }
  }

  const tokens: { file_token: string; name: string }[] = []
  for (const shot of shots) {
    const up = await uploadMediaApi(auth.token, cfg, shot.name, shot.data)
    if ("error" in up) {
      steps.push({ step: "upload", ok: false, message: `${shot.name}: ${up.error} (${up.code})` })
      return {
        ok: false,
        recordId: created.recordId,
        steps,
        warnings: [
          ...warnings,
          "建行已成功但附件上传失败，请到飞书表格手动补附件，或用「复制为飞书行」降级",
        ],
        error: `附件上传失败：${up.error}`,
        code: up.code,
        mode: "api",
      }
    }
    tokens.push(up)
  }
  steps.push({ step: "upload", ok: true, message: `${tokens.length} 张` })

  const upd = await updateAttachmentApi(
    auth.token,
    cfg,
    created.recordId,
    resolveAttachFieldId(schema, warnings),
    tokens,
  )
  if ("error" in upd) {
    steps.push({ step: "attach", ok: false, message: `${upd.error} (${upd.code})` })
    return {
      ok: false,
      recordId: created.recordId,
      steps,
      warnings: [...warnings, "建行已成功但附件字段更新失败，请到飞书表格手动补附件"],
      error: `附件更新失败：${upd.error}`,
      code: upd.code,
      mode: "api",
    }
  }
  steps.push({ step: "attach", ok: true })
  return { ok: true, recordId: created.recordId, steps, warnings, mode: "api" }
}

/**
 * Confirm → local already done by caller → create (no attach) → upload attach.
 * Default: lark-cli --as user. Optional: LARK_PUSH_MODE=api + user token.
 * Never rolls back local files. Missing CLI/credentials → clear error, not fake success.
 */
export async function pushRecordToFeishu(input: LarkPushInput): Promise<LarkPushResult> {
  const cfg = readCfg()
  const missing = missingLarkTarget(cfg)
  if (missing) {
    return {
      ok: false,
      steps: [
        { step: "local", ok: true, message: "本地已落盘" },
        { step: "config", ok: false, message: missing },
      ],
      warnings: [],
      error: missing,
      code: "lark_base_unconfigured",
      mode: cfg.pushMode,
    }
  }
  let schema: FeishuTableSchema
  try {
    schema = await readFeishuTableSchema()
  } catch (e) {
    const message = (e as Error).message
    return {
      ok: false,
      steps: [
        { step: "local", ok: true, message: "本地已落盘" },
        { step: "config", ok: false, message },
      ],
      warnings: [],
      error: message,
      code: "feishu_schema",
      mode: cfg.pushMode,
    }
  }
  if (cfg.pushMode === "api") return pushViaApi(input, cfg, schema)
  return pushViaCli(input, cfg, schema)
}

/** Read saved screenshot files from KB for re-push scenarios */
export async function readScreenshotBuffers(
  kbRoot: string,
  customer: string,
  names: string[],
): Promise<{ name: string; data: Buffer }[]> {
  const dir = path.join(kbRoot, "customers", customer, "files")
  const out: { name: string; data: Buffer }[] = []
  for (const name of names) {
    const p = path.join(dir, name)
    out.push({ name, data: await fs.readFile(p) })
  }
  return out
}
