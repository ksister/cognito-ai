import "server-only"
import fs from "node:fs/promises"
import path from "node:path"
import matter from "gray-matter"
import {
  CHANNELS,
  NEED_TYPES,
  OPEN_STATUSES,
  STATUSES,
  localDate,
  type Channel,
  type CustomerProfile,
  type CustomerSummary,
  type Need,
  type NeedType,
  type RecordDraft,
  type Status,
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
    feishu_synced: r.feishuSynced,
    needs: r.needs,
    created: r.created,
    updated: r.updated,
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
    channel: oneOf<Channel>(data.channel, CHANNELS, "其他"),
    contact: str(data.contact),
    product: str(data.product),
    module: str(data.module),
    category: str(data.category) || "其他",
    status: str(data.status) || "待处理",
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
  }
}

function cleanDraft(d: RecordDraft): RecordDraft {
  return {
    ...d,
    title: d.title.trim(),
    customer: safeName(d.customer),
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : localDate(),
    channel: oneOf<Channel>(d.channel, CHANNELS, "其他"),
    status: (d.status ?? "").trim() || "待处理",
    needs: parseNeeds(d.needs),
    uncertain: (d.uncertain ?? []).map((u) => u.trim()).filter(Boolean),
    chat: (d.chat ?? "").replace(/`{4,}/g, "```"),
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
  const merged = { ...existing, ...patch, customer: existing.customer }
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
      openCount: rs.filter((r) => OPEN_STATUSES.includes(r.status)).length,
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
 * 确认保存后备份原图。
 * 路径约定（相对仓库根）：customers/<客户名>/files/截图-YYYYMMDD-序号.jpg
 * 日期 = 保存当日本地日历日（此处用 localDate，写死为「保存日」而非聊天日）。
 * 同批序号从 1 起；若当日已有同名文件，则从下一个空闲序号起连续编号。
 */
export async function saveScreenshotBatch(customer: string, images: Buffer[]): Promise<string[]> {
  if (!images.length) return []
  const name = safeName(customer)
  const dir = path.join(customerDir(name), "files")
  await fs.mkdir(dir, { recursive: true })
  // 日期 = 保存当日本地日历日 → YYYYMMDD
  const ymd = localDate().replace(/-/g, "")
  let start = 1
  while (await exists(path.join(dir, `截图-${ymd}-${start}.jpg`))) start++
  const saved: string[] = []
  for (let i = 0; i < images.length; i++) {
    const file = `截图-${ymd}-${start + i}.jpg`
    await fs.writeFile(within(dir, file), images[i])
    saved.push(file)
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
