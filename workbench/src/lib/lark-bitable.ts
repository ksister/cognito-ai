import "server-only"
import fs from "node:fs/promises"
import path from "node:path"
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
  attachment: "fld4TZSFx8", // 附件补充 — ONLY via update
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

export type LarkPushResult = {
  ok: boolean
  recordId?: string
  steps: { step: LarkPushStep; ok: boolean; message?: string }[]
  warnings: string[]
  error?: string
  code?: string | number
}

export type LarkPushInput = {
  draft: RecordDraft
  /** Selected Feishu 客户公司1 option; if empty, derived from draft.customer */
  companyOption?: string
  handlerOpenIds?: string[]
  screenshots?: { name: string; data: Buffer }[]
}

type LarkCfg = {
  appId?: string
  appSecret?: string
  userAccessToken?: string
  refreshToken?: string
  baseToken: string
  tableId: string
}

const OPEN = "https://open.feishu.cn/open-apis"

function readCfg(): LarkCfg {
  return {
    appId: process.env.LARK_APP_ID?.trim() || undefined,
    appSecret: process.env.LARK_APP_SECRET?.trim() || undefined,
    userAccessToken: process.env.LARK_USER_ACCESS_TOKEN?.trim() || undefined,
    refreshToken: process.env.LARK_REFRESH_TOKEN?.trim() || undefined,
    baseToken: process.env.LARK_BASE_TOKEN?.trim() || "TIlebbivOaXu73s05YXchV1XnPb",
    tableId: process.env.LARK_TABLE_ID?.trim() || "tbltWWJaNx6bknQV",
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
  // Do not persist refresh_token rotation to disk here (would need writing secrets).
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
      "缺少飞书用户凭证：请在 workbench/.env.local 配置 LARK_USER_ACCESS_TOKEN（推荐），或 LARK_REFRESH_TOKEN + LARK_APP_ID + LARK_APP_SECRET",
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
  const { query: _q, ...rest } = init
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
  const json = (await res.json()) as LarkApiJson
  return json
}

function matchOption(value: string, options: string[]): string | null {
  const v = value.trim()
  if (!v) return null
  const exact = options.find((o) => o === v)
  if (exact) return exact
  const lower = v.toLowerCase()
  const ci = options.find((o) => o.toLowerCase() === lower)
  if (ci) return ci
  const contains = options.find((o) => o.includes(v) || v.includes(o))
  return contains ?? null
}

type FieldMeta = {
  field_id: string
  field_name: string
  type: number
  property?: { options?: { name: string; id?: string }[] }
}

export async function fetchFieldMeta(token: string, cfg: LarkCfg): Promise<FieldMeta[]> {
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

function optionsOf(fields: FieldMeta[], fieldId: string): string[] {
  const f = fields.find((x) => x.field_id === fieldId)
  return (f?.property?.options ?? []).map((o) => o.name).filter(Boolean)
}

export async function getLarkMeta(): Promise<{
  configured: boolean
  error?: string
  code?: string | number
  options: LarkSelectOptions
  handlers: LarkHandler[]
  baseToken: string
  tableId: string
}> {
  const cfg = readCfg()
  const handlers = parseHandlersEnv()
  const empty: LarkSelectOptions = {
    company: [],
    status: [],
    product: [],
    resolveMethod: [],
    supportType: [],
    site: [],
  }
  const auth = await getUserAccessToken(cfg)
  if (!auth.token) {
    return {
      configured: false,
      error: auth.error,
      options: empty,
      handlers,
      baseToken: cfg.baseToken,
      tableId: cfg.tableId,
    }
  }
  try {
    const fields = await fetchFieldMeta(auth.token, cfg)
    return {
      configured: true,
      options: {
        company: optionsOf(fields, LARK_FIELDS.company),
        status: optionsOf(fields, LARK_FIELDS.status),
        product: optionsOf(fields, LARK_FIELDS.product),
        resolveMethod: optionsOf(fields, LARK_FIELDS.resolveMethod),
        supportType: optionsOf(fields, LARK_FIELDS.supportType),
        site: optionsOf(fields, LARK_FIELDS.site),
      },
      handlers,
      baseToken: cfg.baseToken,
      tableId: cfg.tableId,
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
    }
  }
}

/**
 * Build ordinary fields for batch_create — NEVER includes attachment field.
 * Mapping notes:
 * - 解决方式 ← category（黄区问题分类）匹配 select；未命中跳过
 * - 软件版本 ← product；未命中跳过
 * - 处理状态 ← status；未命中不写并警告
 * - 支持类型 ← channel 匹配；项目/现场 ← module 匹配
 */
export function buildCreateFields(
  draft: RecordDraft,
  options: LarkSelectOptions,
  companyOption: string | undefined,
  handlerOpenIds: string[] | undefined,
  warnings: string[],
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  const customer = draft.customer.trim()
  const companyPick =
    (companyOption && options.company.includes(companyOption) && companyOption) ||
    matchOption(customer, options.company)

  let contactParts: string[] = []
  if (companyPick) {
    fields[LARK_FIELDS.company] = companyPick
    if (companyPick === FALLBACK_OTHER_COMPANY && customer) contactParts.push(customer)
  } else if (options.company.includes(FALLBACK_OTHER_COMPANY)) {
    fields[LARK_FIELDS.company] = FALLBACK_OTHER_COMPANY
    if (customer) contactParts.push(customer)
    warnings.push(`客户公司未命中选项，已写入「${FALLBACK_OTHER_COMPANY}」，原名并入客户/联系人`)
  } else if (customer) {
    contactParts.push(customer)
    warnings.push("客户公司选项中无「其他-待确认」且未命中，已跳过客户公司字段")
  }

  if (draft.contact?.trim()) contactParts.push(draft.contact.trim())
  // de-dupe while preserving order
  contactParts = [...new Set(contactParts)]
  if (contactParts.length) fields[LARK_FIELDS.contact] = contactParts.join(" / ")

  const title = (draft.title || draft.problem || "").trim().slice(0, 200)
  if (title) fields[LARK_FIELDS.title] = title

  if (draft.problem?.trim()) {
    fields[LARK_FIELDS.problem] = draft.problem.replace(/\r\n/g, "\n")
  }

  const productHit = matchOption(draft.product ?? "", options.product)
  if (productHit) fields[LARK_FIELDS.product] = productHit
  else if (draft.product?.trim()) warnings.push(`软件版本「${draft.product}」未命中表内选项，已跳过`)

  const resolveHit = matchOption(draft.category ?? "", options.resolveMethod)
  if (resolveHit) fields[LARK_FIELDS.resolveMethod] = resolveHit
  else if (draft.category?.trim())
    warnings.push(`解决方式/分类「${draft.category}」未命中表内选项，已跳过`)

  const statusHit = matchOption(draft.status ?? "", options.status)
  if (statusHit) fields[LARK_FIELDS.status] = statusHit
  else if (draft.status?.trim())
    warnings.push(`处理状态「${draft.status}」未命中表内选项，请改正后再推；本次未写入该字段`)

  const ids = (handlerOpenIds ?? []).map((id) => id.trim()).filter((id) => id.startsWith("ou_"))
  if (ids.length) {
    fields[LARK_FIELDS.handlers] = ids.map((id) => ({ id }))
  }

  if (draft.solution?.trim()) fields[LARK_FIELDS.solution] = draft.solution.replace(/\r\n/g, "\n")
  if (draft.process?.trim()) fields[LARK_FIELDS.process] = draft.process.replace(/\r\n/g, "\n")

  const supportHit = matchOption(draft.channel ?? "", options.supportType)
  if (supportHit) fields[LARK_FIELDS.supportType] = supportHit

  const siteHit = matchOption(draft.module ?? "", options.site)
  if (siteHit) fields[LARK_FIELDS.site] = siteHit

  return fields
}

async function batchCreate(
  token: string,
  cfg: LarkCfg,
  fields: Record<string, unknown>,
): Promise<{ recordId: string } | { error: string; code: number }> {
  // Explicitly strip attachment if somehow present
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

async function uploadMedia(
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
  // 800030005 must never be treated as success — guarded by code !== 0 above
  return { file_token: json.data.file_token, name: fileName }
}

async function updateAttachment(
  token: string,
  cfg: LarkCfg,
  recordId: string,
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
          [LARK_FIELDS.attachment]: files.map((f) => ({
            file_token: f.file_token,
            name: f.name,
          })),
        },
      }),
    },
  )
  if (json.code !== 0) {
    // Explicit: never treat 800030005 (or any non-zero) as success
    return { error: json.msg || "update attachment failed", code: json.code }
  }
  return { ok: true }
}

/**
 * Confirm → local already done by caller → create (no attach) → upload each → update attach only.
 * Never rolls back local files. Missing credentials → clear error, not fake success.
 */
export async function pushRecordToFeishu(input: LarkPushInput): Promise<LarkPushResult> {
  const steps: LarkPushResult["steps"] = [{ step: "local", ok: true, message: "本地已落盘" }]
  const warnings: string[] = []
  const cfg = readCfg()

  const auth = await getUserAccessToken(cfg)
  if (!auth.token) {
    steps.push({ step: "config", ok: false, message: auth.error })
    return { ok: false, steps, warnings, error: auth.error, code: "missing_credentials" }
  }

  let options: LarkSelectOptions
  try {
    const fields = await fetchFieldMeta(auth.token, cfg)
    options = {
      company: optionsOf(fields, LARK_FIELDS.company),
      status: optionsOf(fields, LARK_FIELDS.status),
      product: optionsOf(fields, LARK_FIELDS.product),
      resolveMethod: optionsOf(fields, LARK_FIELDS.resolveMethod),
      supportType: optionsOf(fields, LARK_FIELDS.supportType),
      site: optionsOf(fields, LARK_FIELDS.site),
    }
  } catch (e) {
    const err = e as Error & { code?: number }
    steps.push({ step: "auth", ok: false, message: err.message })
    return { ok: false, steps, warnings, error: err.message, code: err.code ?? "meta_failed" }
  }

  const createFields = buildCreateFields(
    input.draft,
    options,
    input.companyOption,
    input.handlerOpenIds,
    warnings,
  )

  const created = await batchCreate(auth.token, cfg, createFields)
  if ("error" in created) {
    steps.push({ step: "create", ok: false, message: `${created.error} (${created.code})` })
    return {
      ok: false,
      steps,
      warnings,
      error: `建行失败：${created.error}`,
      code: created.code,
    }
  }
  steps.push({ step: "create", ok: true, message: created.recordId })

  const shots = input.screenshots ?? []
  if (!shots.length) {
    return { ok: true, recordId: created.recordId, steps, warnings }
  }

  const tokens: { file_token: string; name: string }[] = []
  for (const shot of shots) {
    const up = await uploadMedia(auth.token, cfg, shot.name, shot.data)
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
      }
    }
    tokens.push(up)
  }
  steps.push({ step: "upload", ok: true, message: `${tokens.length} 张` })

  const upd = await updateAttachment(auth.token, cfg, created.recordId, tokens)
  if ("error" in upd) {
    steps.push({ step: "attach", ok: false, message: `${upd.error} (${upd.code})` })
    return {
      ok: false,
      recordId: created.recordId,
      steps,
      warnings: [
        ...warnings,
        "建行已成功但附件字段更新失败，请到飞书表格手动补附件",
      ],
      error: `附件更新失败：${upd.error}`,
      code: upd.code,
    }
  }
  steps.push({ step: "attach", ok: true })
  return { ok: true, recordId: created.recordId, steps, warnings }
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
