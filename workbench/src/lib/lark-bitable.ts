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
import {
  RECORD_NOT_READY_DELAY_MS,
  cliRelativeFile,
  extractCliRecordId,
  isRecordNotReady,
  omitAttachmentFields,
  pushActionFor,
  sameRowUpdateError,
  screenshotsToUpload,
} from "./lark-push-plan"
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
  | "update"
  | "upload"
  | "attach"
  | "config"
  | "auth"
  | "cli"

export type LarkPushResult = {
  ok: boolean
  recordId?: string
  /** created = new row. updated = the stored feishu_record_id. */
  action?: "created" | "updated"
  /** Screenshot filenames uploaded on this call. */
  attachedNames?: string[]
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
  /** When set, update this Feishu row instead of creating another. */
  feishuRecordId?: string
  /** Filenames already uploaded. Only names outside this list are uploaded again. */
  attachedNames?: string[]
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
  return extractCliRecordId(json)
}

function attachmentFieldIds(schema: FeishuTableSchema): string[] {
  return [
    LARK_FIELDS.attachment,
    ...schema.columns.filter((col) => col.type === "attachment" && col.fieldId).map((col) => col.fieldId as string),
  ]
}

function fieldsForCliWrite(fields: Record<string, unknown>, schema: FeishuTableSchema): Record<string, unknown> {
  return omitAttachmentFields(fields, attachmentFieldIds(schema))
}

async function retryIfNotReady<T>(fn: () => Promise<T>): Promise<T> {
  const first = await fn()
  const failed = first as { error?: unknown; code?: string | number }
  if (typeof failed.error === "string" && failed.error && isRecordNotReady(failed.code, failed.error)) {
    await new Promise((resolve) => setTimeout(resolve, RECORD_NOT_READY_DELAY_MS))
    return fn()
  }
  return first
}

/**
 * `--file` must be relative to the process cwd. Files outside cwd are copied
 * under `.tmp/` for the duration of the CLI call, then removed.
 */
async function withCliRelativeFiles<T>(
  files: { name: string; path: string }[],
  fn: (staged: { name: string; path: string }[]) => Promise<T>,
): Promise<T> {
  const cwd = process.cwd()
  const dir = path.join(cwd, ".tmp", `lark-attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await fs.mkdir(dir, { recursive: true })
  try {
    const staged: { name: string; path: string }[] = []
    for (const [i, file] of files.entries()) {
      const direct = cliRelativeFile(cwd, file.path)
      if (direct) {
        staged.push({ name: file.name, path: direct })
        continue
      }
      const dest = path.join(dir, `${i}-${path.basename(file.path)}`)
      await fs.copyFile(file.path, dest)
      const rel = cliRelativeFile(cwd, dest)
      if (!rel) throw new Error("附件无法转成当前目录下的相对路径，lark-cli 会拒绝绝对路径")
      staged.push({ name: file.name, path: rel })
    }
    return await fn(staged)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
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

/** Field names, ids, and select options from lark-cli. Ids stay in the private config. */
export async function listFeishuFieldOptions(): Promise<
  { ok: true; fields: { name: string; fieldId: string; options: string[]; type: number }[] } | { ok: false; error: string }
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
        fieldId: f.field_id,
        type: f.type,
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

/**
 * Update one existing row. JSON is a flat { fieldId: value } object.
 * `--record-id` is required so a missing id cannot fall through into a create.
 */
async function upsertViaCli(
  cliPath: string,
  cfg: LarkCfg,
  recordId: string,
  fields: Record<string, unknown>,
): Promise<{ recordId: string } | { error: string; code: string | number }> {
  return withTempJsonFile(fields, async (tmp) => {
    const head = [
      "base",
      "+record-upsert",
      "--base-token",
      cfg.baseToken,
      "--table-id",
      cfg.tableId,
      "--record-id",
      recordId,
    ]
    const tail = ["--as", "user", "--format", "json"]
    let used = await runLarkCli(cliPath, [...head, "--json", `@${tmp}`, ...tail])
    if (!isCliSuccess(used) && /json|@|file|parse|invalid/i.test(cliErrorMessage(used).message)) {
      used = await runLarkCli(cliPath, [...head, "--json", JSON.stringify(fields), ...tail])
    }
    if (!isCliSuccess(used)) {
      const e = cliErrorMessage(used)
      return { error: e.message, code: e.code }
    }
    const mismatch = sameRowUpdateError(used.json, recordId)
    if (mismatch) return { error: mismatch, code: "unexpected_create" }
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
  try {
    return await withCliRelativeFiles(files, async (staged) => {
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
      for (const f of staged) {
        args.push("--file", f.path)
      }
      args.push("--as", "user", "--format", "json")
      const run = await runLarkCli(cliPath, args)
      if (!isCliSuccess(run)) {
        const e = cliErrorMessage(run)
        return { error: e.message, code: e.code }
      }
      return { ok: true as const }
    })
  } catch (e) {
    return { error: (e as Error).message, code: "attach_path" }
  }
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
  "飞书表结构配置里没有可写入的 fieldId，cli 无法建行。请在记一笔页点「从飞书同步字段」确认后写入私有 feishu-table.json，或按列名手填 fieldId。真实 id 不要提交。复制为飞书行仍可作兜底。"

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

async function updateRecordApi(
  token: string,
  cfg: LarkCfg,
  recordId: string,
  fields: Record<string, unknown>,
): Promise<{ recordId: string } | { error: string; code: number | string }> {
  const json = await larkFetch(
    token,
    `${OPEN}/bitable/v1/apps/${cfg.baseToken}/tables/${cfg.tableId}/records/${recordId}`,
    {
      method: "PUT",
      query: { user_id_type: "open_id" },
      body: JSON.stringify({ fields }),
    },
  )
  if (json.code !== 0) return { error: json.msg || "update failed", code: json.code }
  const data = json.data as { record?: { record_id?: string } } | undefined
  const returned = data?.record?.record_id
  if (returned && returned !== recordId) {
    return { error: "更新返回了另一个 record_id，已中止以免改去指向第二行", code: "unexpected_create" }
  }
  return { recordId }
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
  const cliPath = resolved.path

  try {
    await fetchFieldMetaViaCli(cliPath, cfg)
  } catch (e) {
    const err = e as Error & { code?: string | number }
    steps.push({ step: "auth", ok: false, message: err.message })
    return { ok: false, steps, warnings, error: err.message, code: err.code ?? "meta_failed", mode: "cli" }
  }

  const writeFields = fieldsForCliWrite(
    buildCreateFields(input.draft, schema, input.companyOption, input.handlerOpenIds, warnings),
    schema,
  )
  const existingId = input.feishuRecordId?.trim() || ""
  const updating = pushActionFor(existingId) === "update"

  let recordId = existingId
  if (updating) {
    const updated = await retryIfNotReady(() => upsertViaCli(cliPath, cfg, existingId, writeFields))
    if ("error" in updated) {
      steps.push({ step: "update", ok: false, message: `${updated.error} (${updated.code})` })
      return {
        ok: false,
        action: "updated",
        recordId: existingId,
        steps,
        warnings,
        error: `更新失败：${updated.error}`,
        code: updated.code,
        mode: "cli",
      }
    }
    recordId = existingId
    steps.push({ step: "update", ok: true, message: recordId })
  } else {
    const created = await batchCreateViaCli(cliPath, cfg, writeFields)
    if ("error" in created) {
      steps.push({ step: "create", ok: false, message: `${created.error} (${created.code})` })
      return {
        ok: false,
        action: "created",
        steps,
        warnings,
        error: `建行失败：${created.error}`,
        code: created.code,
        mode: "cli",
      }
    }
    recordId = created.recordId
    steps.push({ step: "create", ok: true, message: recordId })
  }

  const files = await resolveScreenshotFiles(input)
  const pending = files.filter((file) =>
    screenshotsToUpload(
      files.map((item) => item.name),
      input.attachedNames,
    ).includes(file.name),
  )
  if (!pending.length) {
    return {
      ok: true,
      action: updating ? "updated" : "created",
      recordId,
      attachedNames: [],
      steps,
      warnings,
      mode: "cli",
    }
  }

  const up = await retryIfNotReady(() =>
    uploadAttachmentsViaCli(cliPath, cfg, recordId, resolveAttachFieldId(schema, warnings), pending),
  )
  if ("error" in up) {
    steps.push({ step: "attach", ok: false, message: `${up.error} (${up.code})` })
    return {
      ok: false,
      action: updating ? "updated" : "created",
      recordId,
      attachedNames: [],
      steps,
      warnings: [
        ...warnings,
        updating
          ? "字段已按这一行更新，但新截图没有传上。飞书里原来的附件还在。可再次同步，或到表格里手动补。"
          : "建行已成功但附件上传失败。行号会写回本地，再次同步会更新这一行而不是再建。",
      ],
      error: `附件上传失败：${up.error}`,
      code: up.code,
      mode: "cli",
    }
  }
  steps.push({ step: "upload", ok: true, message: `${pending.length} 张` })
  steps.push({ step: "attach", ok: true })
  return {
    ok: true,
    action: updating ? "updated" : "created",
    recordId,
    attachedNames: pending.map((file) => file.name),
    steps,
    warnings,
    mode: "cli",
  }
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
  const token = auth.token

  try {
    await fetchFieldMetaApi(token, cfg)
  } catch (e) {
    const err = e as Error & { code?: number }
    steps.push({ step: "auth", ok: false, message: err.message })
    return { ok: false, steps, warnings, error: err.message, code: err.code ?? "meta_failed", mode: "api" }
  }

  const writeFields = fieldsForCliWrite(
    buildCreateFields(input.draft, schema, input.companyOption, input.handlerOpenIds, warnings),
    schema,
  )
  const existingId = input.feishuRecordId?.trim() || ""
  const updating = pushActionFor(existingId) === "update"

  let recordId = existingId
  if (updating) {
    const updated = await retryIfNotReady(() => updateRecordApi(token, cfg, existingId, writeFields))
    if ("error" in updated) {
      steps.push({ step: "update", ok: false, message: `${updated.error} (${updated.code})` })
      return {
        ok: false,
        action: "updated",
        recordId: existingId,
        steps,
        warnings,
        error: `更新失败：${updated.error}`,
        code: updated.code,
        mode: "api",
      }
    }
    recordId = existingId
    steps.push({ step: "update", ok: true, message: recordId })
  } else {
    const created = await batchCreateApi(token, cfg, writeFields)
    if ("error" in created) {
      steps.push({ step: "create", ok: false, message: `${created.error} (${created.code})` })
      return {
        ok: false,
        action: "created",
        steps,
        warnings,
        error: `建行失败：${created.error}`,
        code: created.code,
        mode: "api",
      }
    }
    recordId = created.recordId
    steps.push({ step: "create", ok: true, message: recordId })
  }

  const disk = await resolveScreenshotFiles(input)
  const pendingNames = screenshotsToUpload(
    disk.length ? disk.map((file) => file.name) : (input.screenshots ?? []).map((shot) => shot.name),
    input.attachedNames,
  )
  if (updating) {
    if (pendingNames.length) {
      warnings.push(
        "API 模式这次只更新字段，不改附件列，避免清掉飞书里已有附件。新截图请改回 lark-cli（默认）再同步一次。",
      )
    }
    return {
      ok: true,
      action: "updated",
      recordId,
      attachedNames: [],
      steps,
      warnings,
      mode: "api",
    }
  }

  const shots: { name: string; data: Buffer }[] = []
  if (disk.length) {
    for (const file of disk) {
      if (!pendingNames.includes(file.name)) continue
      shots.push({ name: file.name, data: await fs.readFile(file.path) })
    }
  } else {
    for (const shot of input.screenshots ?? []) {
      if (pendingNames.includes(shot.name)) shots.push(shot)
    }
  }

  if (!shots.length) {
    return { ok: true, action: "created", recordId, attachedNames: [], steps, warnings, mode: "api" }
  }

  const tokens: { file_token: string; name: string }[] = []
  for (const shot of shots) {
    const up = await uploadMediaApi(token, cfg, shot.name, shot.data)
    if ("error" in up) {
      steps.push({ step: "upload", ok: false, message: `${shot.name}: ${up.error} (${up.code})` })
      return {
        ok: false,
        action: "created",
        recordId,
        attachedNames: [],
        steps,
        warnings: [
          ...warnings,
          "建行已成功但附件上传失败。行号会写回本地，再次同步会更新这一行而不是再建。",
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
    token,
    cfg,
    recordId,
    resolveAttachFieldId(schema, warnings),
    tokens,
  )
  if ("error" in upd) {
    steps.push({ step: "attach", ok: false, message: `${upd.error} (${upd.code})` })
    return {
      ok: false,
      action: "created",
      recordId,
      attachedNames: [],
      steps,
      warnings: [...warnings, "建行已成功但附件字段更新失败，请到飞书表格手动补附件"],
      error: `附件更新失败：${upd.error}`,
      code: upd.code,
      mode: "api",
    }
  }
  steps.push({ step: "attach", ok: true })
  return {
    ok: true,
    action: "created",
    recordId,
    attachedNames: shots.map((shot) => shot.name),
    steps,
    warnings,
    mode: "api",
  }
}

/**
 * Local save is already done by the caller.
 * No feishu_record_id → batch-create, then upload new screenshots.
 * With feishu_record_id → upsert that row. New screenshot names are appended;
 * the attachment column is not replaced, so older files stay.
 * Default: lark-cli --as user. Optional: LARK_PUSH_MODE=api + user token.
 * Never rolls back local files. Missing CLI/credentials → clear error, not fake success.
 */
export async function pushRecordToFeishu(input: LarkPushInput): Promise<LarkPushResult> {
  const storedId = input.feishuRecordId?.trim() || ""
  const finish = (result: LarkPushResult): LarkPushResult => {
    if (!storedId) return { ...result, action: result.action ?? "created" }
    return {
      ...result,
      action: result.action ?? "updated",
      recordId: result.recordId || storedId,
    }
  }
  const cfg = readCfg()
  const missing = missingLarkTarget(cfg)
  if (missing) {
    return finish({
      ok: false,
      steps: [
        { step: "local", ok: true, message: "本地已落盘" },
        { step: "config", ok: false, message: missing },
      ],
      warnings: [],
      error: missing,
      code: "lark_base_unconfigured",
      mode: cfg.pushMode,
    })
  }
  let schema: FeishuTableSchema
  try {
    schema = await readFeishuTableSchema()
  } catch (e) {
    const message = (e as Error).message
    return finish({
      ok: false,
      steps: [
        { step: "local", ok: true, message: "本地已落盘" },
        { step: "config", ok: false, message },
      ],
      warnings: [],
      error: message,
      code: "feishu_schema",
      mode: cfg.pushMode,
    })
  }
  if (cfg.pushMode === "api") return finish(await pushViaApi(input, cfg, schema))
  return finish(await pushViaCli(input, cfg, schema))
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
