import "server-only"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import matter from "gray-matter"
import { allocateScreenshotNames } from "./screenshot-name"
import {
  closedStatusesOf,
  extrasFromFrontmatter,
  isOpenStatus,
  legacyStatusMapOf,
  mapLegacyStatus,
  parseFeishuTableSchema,
  sanitizeExtras,
  type FeishuTableSchema,
} from "./feishu-schema"
import {
  NEED_TYPES,
  localDate,
  type CustomerProfile,
  type CustomerSummary,
  type Need,
  type NeedType,
  type RecordDraft,
  type SupportRecord,
} from "./types"

export const KB_ROOT = path.resolve(process.env.KB_DIR ?? path.join(process.cwd(), ".."))
const CUSTOMERS_DIR = path.join(KB_ROOT, "customers")
const REQUIREMENTS_DIR = path.join(KB_ROOT, "requirements")

const SECTION = {
  problem: "问题描述",
  process: "处理过程",
  solution: "解决方案",
  thoughts: "我的思考",
  uncertain: "待确认",
  chat: "原始聊天记录",
} as const

export function safeName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 80)
  if (!cleaned) throw new Error("名称不能为空")
  return cleaned
}

function within(base: string, ...parts: string[]): string {
  const p = path.resolve(base, ...parts)
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error("非法路径")
  return p
}

function customerDir(customer: string) {
  return within(CUSTOMERS_DIR, safeName(customer))
}

async function exists(p: string) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((item) => str(item).trim()).filter(Boolean)
  if (typeof v === "string" && v.trim()) return v.split(/[,，、;；]/).map((item) => item.trim()).filter(Boolean)
  return []
}

let schemaCache: { mtimeMs: number; schema: FeishuTableSchema | null } | null = null

function readPrivateSchema(): FeishuTableSchema | null {
  const filePath = path.join(KB_ROOT, "config", "feishu-table.json")
  try {
    const stat = fsSync.statSync(filePath)
    if (schemaCache && schemaCache.mtimeMs === stat.mtimeMs) return schemaCache.schema
    const schema = parseFeishuTableSchema(JSON.parse(fsSync.readFileSync(filePath, "utf8")), filePath)
    schemaCache = { mtimeMs: stat.mtimeMs, schema }
    return schema
  } catch {
    schemaCache = { mtimeMs: -1, schema: null }
    return null
  }
}

export async function listSiteSuggestions(): Promise<string[]> {
  const records = await listRecords()
  return [...new Set(records.map((r) => r.site.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"))
}

export function recordIsOpen(status: string): boolean {
  return isOpenStatus(status, closedStatusesOf(readPrivateSchema()))
}

export function nextLocalId(date: string, used: Iterable<string>): string {
  const ymd = (/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localDate()).replace(/-/g, "")
  const re = new RegExp(`^AE-${ymd}-(\\d+)$`)
  let max = 0
  for (const id of used) {
    const m = id.match(re)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `AE-${ymd}-${String(max + 1).padStart(2, "0")}`
}

function str(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (v === null || v === undefined) return ""
  return String(v)
}

function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return list.includes(v as T) ? (v as T) : fallback
}

function nowIso() {
  return new Date().toISOString()
}

function splitSections(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  const chatHeader = `\n## ${SECTION.chat}`
  const chatIdx = ("\n" + body).indexOf(chatHeader)
  let rest = body
  if (chatIdx >= 0) {
    rest = body.slice(0, Math.max(0, chatIdx - 1))
    const chatPart = ("\n" + body).slice(chatIdx + chatHeader.length)
    out[SECTION.chat] = chatPart
      .replace(/^\s*\n/, "")
      .replace(/^`{4,}[^\n]*\n/, "")
      .replace(/\n`{4,}\s*$/, "")
      .replace(/\s+$/, "")
  }
  const parts = ("\n" + rest).split(/\n## /)
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n")
    const heading = (nl < 0 ? part : part.slice(0, nl)).trim()
    out[heading] = nl < 0 ? "" : part.slice(nl + 1).trim()
  }
  return out
}

function parseList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*(\[[ x]\]\s*)?/, "").trim())
    .filter(Boolean)
}

function parseNeeds(v: unknown): Need[] {
  if (!Array.isArray(v)) return []
  return v
    .map((n) => ({
      pain: str(n?.pain),
      idea: str(n?.idea),
      type: oneOf<NeedType>(n?.type, NEED_TYPES, "其他"),
    }))
    .filter((n) => n.pain || n.idea)
}

function extraFrontmatter(r: SupportRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ["site", "support_type", "resolution", "fixed_version", "case_visibility", "docs", "local_id"] as const) {
    if (r[key]?.trim()) out[key] = r[key].trim()
  }
  for (const key of ["dimensions", "inspection_types", "industries"] as const) {
    if (r[key]?.length) out[key] = r[key]
  }
  for (const [k, v] of Object.entries(r.extras ?? {})) {
    if (v.trim()) out[k] = v
  }
  return out
}

export function recordToMarkdown(r: SupportRecord): string {
  const fm = {
    title: r.title,
    date: r.date,
    customer: r.customer,
    channel: r.channel,
    contact: r.contact,
    product: r.product,
    module: r.module,
    category: r.category,
    status: r.status,
    ...extraFrontmatter(r),
    feishu_synced: r.feishuSynced,
    needs: r.needs,
    created: r.created,
    updated: r.updated,
    ...(r.screenshots?.length ? { screenshots: r.screenshots } : {}),
  }
  const fence = "````"
  const body = [
    `# ${r.title || "未命名记录"}`,
    "",
    `## ${SECTION.problem}`,
    r.problem,
    "",
    `## ${SECTION.process}`,
    r.process,
    "",
    `## ${SECTION.solution}`,
    r.solution,
    "",
    `## ${SECTION.thoughts}`,
    r.thoughts,
    "",
    `## ${SECTION.uncertain}`,
    r.uncertain.map((u) => `- ${u}`).join("\n"),
    "",
    `## ${SECTION.chat}`,
    `${fence}text`,
    r.chat,
    fence,
    "",
  ].join("\n")
  return matter.stringify(body, fm)
}

export function markdownToRecord(customer: string, file: string, raw: string): SupportRecord {
  const { data, content } = matter(raw)
  const body = content.replace(/^\s*# [^\n]*\n/, "")
  const s = splitSections(body)
  return {
    id: `${customer}/${file.replace(/\.md$/, "")}`,
    file,
    customer,
    title: str(data.title) || file.replace(/\.md$/, ""),
    date: str(data.date) || file.slice(0, 10),
    channel: str(data.channel),
    contact: str(data.contact),
    product: str(data.product),
    module: str(data.module),
    category: str(data.category),
    status: mapLegacyStatus(str(data.status), legacyStatusMapOf(readPrivateSchema())),
    site: str(data.site),
    support_type: str(data.support_type),
    resolution: str(data.resolution),
    fixed_version: str(data.fixed_version),
    dimensions: strList(data.dimensions),
    inspection_types: strList(data.inspection_types),
    industries: strList(data.industries),
    case_visibility: str(data.case_visibility),
    docs: str(data.docs),
    local_id: str(data.local_id),
    feishuSynced: Boolean(data.feishu_synced),
    needs: parseNeeds(data.needs),
    created: str(data.created),
    updated: str(data.updated),
    problem: s[SECTION.problem] ?? "",
    process: s[SECTION.process] ?? "",
    solution: s[SECTION.solution] ?? "",
    thoughts: s[SECTION.thoughts] ?? "",
    uncertain: parseList(s[SECTION.uncertain] ?? ""),
    chat: s[SECTION.chat] ?? "",
    screenshots: parseScreenshots(data.screenshots),
    extras: extrasFromFrontmatter(data as Record<string, unknown>),
  }
}

function parseScreenshots(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => str(x).trim()).filter(Boolean)
  if (typeof v === "string" && v.trim()) return [v.trim()]
  return []
}

function cleanDraft(d: RecordDraft): RecordDraft {
  return {
    ...d,
    title: d.title.trim(),
    customer: safeName(d.customer),
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : localDate(),
    channel: (d.channel ?? "").trim(),
    status: mapLegacyStatus((d.status ?? "").trim(), legacyStatusMapOf(readPrivateSchema())),
    category: (d.category ?? "").trim(),
    site: (d.site ?? "").trim(),
    support_type: (d.support_type ?? "").trim(),
    resolution: (d.resolution ?? "").trim(),
    fixed_version: (d.fixed_version ?? "").trim(),
    dimensions: strList(d.dimensions),
    inspection_types: strList(d.inspection_types),
    industries: strList(d.industries),
    case_visibility: (d.case_visibility ?? "").trim(),
    docs: (d.docs ?? "").trim(),
    local_id: (d.local_id ?? "").trim(),
    extras: sanitizeExtras(d.extras),
    needs: parseNeeds(d.needs),
    uncertain: (d.uncertain ?? []).map((u) => u.trim()).filter(Boolean),
    chat: (d.chat ?? "").replace(/`{4,}/g, "```"),
    screenshots: parseScreenshots(d.screenshots),
  }
}

export async function listCustomerNames(): Promise<string[]> {
  if (!(await exists(CUSTOMERS_DIR))) return []
  const entries = await fs.readdir(CUSTOMERS_DIR, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
}

export async function listRecords(customer?: string): Promise<SupportRecord[]> {
  const names = customer ? [safeName(customer)] : await listCustomerNames()
  const all: SupportRecord[] = []
  for (const name of names) {
    const dir = path.join(customerDir(name), "records")
    if (!(await exists(dir))) continue
    for (const file of await fs.readdir(dir)) {
      if (!file.endsWith(".md")) continue
      const raw = await fs.readFile(path.join(dir, file), "utf8")
      all.push(markdownToRecord(name, file, raw))
    }
  }
  return all.sort((a, b) => (b.date + b.created).localeCompare(a.date + a.created))
}

export async function getRecord(customer: string, file: string): Promise<SupportRecord | null> {
  const p = within(customerDir(customer), "records", safeName(file) + ".md")
  if (!(await exists(p))) return null
  return markdownToRecord(safeName(customer), path.basename(p), await fs.readFile(p, "utf8"))
}

export async function createRecord(draft: RecordDraft): Promise<SupportRecord> {
  const d = cleanDraft(draft)
  if (!d.local_id) {
    const used = (await listRecords()).map((r) => r.local_id).filter(Boolean)
    d.local_id = nextLocalId(d.date, used)
  }
  const dir = path.join(customerDir(d.customer), "records")
  await fs.mkdir(dir, { recursive: true })
  await ensureProfile(d.customer)
  const slug = (d.title || "记录").replace(/[\s\\/:*?"<>|#^[\]]+/g, "-").slice(0, 30)
  let file = `${d.date}-${slug}.md`
  for (let i = 2; await exists(path.join(dir, file)); i++) file = `${d.date}-${slug}-${i}.md`
  const now = nowIso()
  const rec: SupportRecord = {
    ...d,
    id: `${d.customer}/${file.replace(/\.md$/, "")}`,
    file,
    feishuSynced: false,
    created: now,
    updated: now,
  }
  await fs.writeFile(path.join(dir, file), recordToMarkdown(rec), "utf8")
  return rec
}

export async function updateRecord(
  customer: string,
  file: string,
  patch: Partial<RecordDraft> & { feishuSynced?: boolean },
): Promise<SupportRecord> {
  const existing = await getRecord(customer, file)
  if (!existing) throw new Error("记录不存在")
  const merged = {
    ...existing,
    ...patch,
    customer: existing.customer,
    local_id: existing.local_id || patch.local_id || "",
  }
  const d = cleanDraft(merged)
  const rec: SupportRecord = {
    ...existing,
    ...d,
    feishuSynced: patch.feishuSynced ?? existing.feishuSynced,
    updated: nowIso(),
  }
  const p = within(customerDir(existing.customer), "records", existing.file)
  await fs.writeFile(p, recordToMarkdown(rec), "utf8")
  return rec
}

/** Assign local_id on first copy. Already-synced rows are reported so the UI can warn. */
export async function ensureLocalIds(ids: string[]): Promise<{ records: SupportRecord[]; already: string[] }> {
  const all = await listRecords()
  const used = new Set(all.map((r) => r.local_id).filter(Boolean))
  const records: SupportRecord[] = []
  const already: string[] = []
  for (const id of ids) {
    const rec = all.find((r) => r.id === id)
    if (!rec) continue
    if (rec.feishuSynced && rec.local_id) already.push(rec.local_id)
    if (rec.local_id) {
      records.push(rec)
      continue
    }
    const local_id = nextLocalId(rec.date, used)
    used.add(local_id)
    records.push(await updateRecord(rec.customer, rec.file.replace(/\.md$/, ""), { local_id }))
  }
  return { records, already }
}

const PROFILE_FIELDS: { key: keyof Omit<CustomerProfile, "name" | "notes">; label: string }[] = [
  { key: "stage", label: "阶段" },
  { key: "industry", label: "行业/场景" },
  { key: "products", label: "使用的软件/版本" },
  { key: "hardware", label: "硬件配置" },
  { key: "contacts", label: "联系人" },
]

async function ensureProfile(customer: string) {
  const p = path.join(customerDir(customer), "profile.md")
  if (await exists(p)) return
  await saveProfile({
    name: customer,
    stage: "",
    industry: "",
    products: "",
    hardware: "",
    contacts: "",
    notes: "",
  })
}

export async function getProfile(customer: string): Promise<CustomerProfile> {
  const name = safeName(customer)
  const p = path.join(customerDir(name), "profile.md")
  const profile: CustomerProfile = {
    name,
    stage: "",
    industry: "",
    products: "",
    hardware: "",
    contacts: "",
    notes: "",
  }
  if (!(await exists(p))) return profile
  const { data, content } = matter(await fs.readFile(p, "utf8"))
  for (const f of PROFILE_FIELDS) profile[f.key] = str(data[f.key])
  profile.notes = content.replace(/^\s*# [^\n]*\n/, "").replace(/^\s*## 备注\s*\n/, "").trim()
  return profile
}

export async function saveProfile(profile: CustomerProfile): Promise<void> {
  const name = safeName(profile.name)
  const dir = customerDir(name)
  await fs.mkdir(dir, { recursive: true })
  const fm: Record<string, string> = { type: "customer" }
  for (const f of PROFILE_FIELDS) fm[f.key] = profile[f.key] ?? ""
  const body = `# ${name}\n\n## 备注\n${profile.notes ?? ""}\n`
  await fs.writeFile(path.join(dir, "profile.md"), matter.stringify(body, fm), "utf8")
}

export async function listCustomers(): Promise<CustomerSummary[]> {
  const [names, records] = await Promise.all([listCustomerNames(), listRecords()])
  const out: CustomerSummary[] = []
  for (const name of names) {
    const rs = records.filter((r) => r.customer === name)
    const dates = rs.map((r) => r.date).sort()
    out.push({
      ...(await getProfile(name)),
      recordCount: rs.length,
      openCount: rs.filter((r) => recordIsOpen(r.status)).length,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      needCount: rs.reduce((n, r) => n + r.needs.length, 0),
    })
  }
  return out.sort((a, b) => (b.lastDate ?? "").localeCompare(a.lastDate ?? ""))
}

export type CustomerFile = { name: string; size: number; mtime: string }

export async function listFiles(customer: string): Promise<CustomerFile[]> {
  const dir = path.join(customerDir(customer), "files")
  if (!(await exists(dir))) return []
  const out: CustomerFile[] = []
  for (const name of await fs.readdir(dir)) {
    if (name.startsWith(".")) continue
    const st = await fs.stat(path.join(dir, name))
    if (st.isFile()) out.push({ name, size: st.size, mtime: st.mtime.toISOString() })
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime))
}

export async function saveFile(customer: string, name: string, data: Buffer): Promise<string> {
  const dir = path.join(customerDir(customer), "files")
  await fs.mkdir(dir, { recursive: true })
  const ext = path.extname(name)
  const base = safeName(path.basename(name, ext))
  let file = base + ext
  for (let i = 2; await exists(path.join(dir, file)); i++) file = `${base}-${i}${ext}`
  await fs.writeFile(within(dir, file), data)
  return file
}

export function filePath(customer: string, name: string): string {
  return within(path.join(customerDir(customer), "files"), safeName(name))
}


/**
 * 确认保存后备份截图。
 * 新文件：`<记录 date>-<标题前 20 字>-<序号>.jpg`，date 用聊天日期。
 * 已有的 `截图-YYYYMMDD-N.jpg` 不改名；只在新名字冲突时顺延序号。
 */
export async function saveScreenshotBatch(
  customer: string,
  images: Buffer[],
  meta: { date: string; title: string },
): Promise<string[]> {
  if (!images.length) return []
  const name = safeName(customer)
  const dir = path.join(customerDir(name), "files")
  await fs.mkdir(dir, { recursive: true })
  const existing = (await exists(dir) ? await fs.readdir(dir) : []).filter((n) => !n.startsWith("."))
  const saved = allocateScreenshotNames(existing, meta.date, meta.title, images.length)
  for (let i = 0; i < images.length; i++) {
    await fs.writeFile(within(dir, saved[i]), images[i])
  }
  return saved
}

export async function readProfileContext(): Promise<string> {
  const p = path.join(KB_ROOT, "01-me", "profile.md")
  if (!(await exists(p))) return ""
  return (await fs.readFile(p, "utf8")).slice(0, 3000)
}

export type RequirementDoc = { file: string; title: string; date: string; content: string }

export async function listRequirementDocs(): Promise<RequirementDoc[]> {
  if (!(await exists(REQUIREMENTS_DIR))) return []
  const out: RequirementDoc[] = []
  for (const file of await fs.readdir(REQUIREMENTS_DIR)) {
    if (!file.endsWith(".md")) continue
    const raw = await fs.readFile(path.join(REQUIREMENTS_DIR, file), "utf8")
    const { data, content } = matter(raw)
    out.push({
      file,
      title: str(data.title) || file.replace(/\.md$/, ""),
      date: str(data.date) || file.slice(0, 10),
      content: content.trim(),
    })
  }
  return out.sort((a, b) => b.file.localeCompare(a.file))
}

export async function saveRequirementDoc(title: string, content: string): Promise<string> {
  await fs.mkdir(REQUIREMENTS_DIR, { recursive: true })
  const date = localDate()
  let file = `${date}-需求分析.md`
  for (let i = 2; await exists(path.join(REQUIREMENTS_DIR, file)); i++) file = `${date}-需求分析-${i}.md`
  await fs.writeFile(
    path.join(REQUIREMENTS_DIR, file),
    matter.stringify(content, { type: "requirement-analysis", title, date }),
    "utf8",
  )
  return file
}
