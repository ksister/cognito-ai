/**
 * T26 回放测试：快照的数据结构和纯函数（不碰磁盘、不碰网络，可单测）。
 *
 * 设计要点（D21 / D22）：
 *  - 快照是飞书正式表的只读副本，放 KB_DIR/replay/snapshot/，页面只读快照。
 *  - R 编号沿用 T25 导出的编号；没有编号的记录按日期顺序往后编，编号一旦分配永不变。
 *  - 「飞书为空」= 问题描述、解决方案两列都为空，可筛选。
 *  - 测试状态来自 replay/results/（T27 写），T26 阶段全部是「未测」。
 *
 * Script-safe: no `server-only`, `.ts` suffix on relative runtime imports.
 */

export type ReplayStatus = "untested" | "tested" | "issue"

export type ReplayShotRef = {
  /** 截图内容哈希（sha256 前 32 位），即 media/ 和 transcripts/ 里的文件名。 */
  hash: string
  /** 相对 snapshot 目录：media/<hash>.<ext> */
  file: string
  /** 相对 snapshot 目录：transcripts/<hash>.json */
  transcript: string
  isChat: boolean
  /** 非聊天截图的分类（报错/界面/效果图），聊天截图没有。 */
  category?: string
  model?: string
  at?: string
}

export type ReplayAttachmentRef = {
  token: string
  name: string
  kind: "image" | "other"
  hash?: string
}

/** 一条记录的快照明细，存 snapshot/records/<R编号>.json（T27 左右对比用）。 */
export type ReplayRecordDetail = {
  r: string
  recordId: string
  title: string
  date: string
  customer: string
  localId: string
  problem: string
  solution: string
  attachments: ReplayAttachmentRef[]
  shots: ReplayShotRef[]
  /**
   * T27：表结构里全部字段的文本值（key → 文本），左右对比的左列。
   * 老快照没有这个字段，刷新一次快照就会补上（refresh 会把缺 fields 的明细重写一遍）。
   */
  fields?: Record<string, string>
  /** 这条记录的 R 编号是从哪来的：T25 导出 / 新分配。 */
  numberSource: "t25" | "new"
  importedAt: string
}

/** 列表用的精简记录（manifest.json 里，页面一次读入）。 */
export type ReplayRecordSummary = {
  r: string
  recordId: string
  title: string
  date: string
  customer: string
  screenshotCount: number
  feishuEmpty: boolean
}

export type ReplayManifest = {
  version: 1
  updatedAt: string
  /** 快照来源表：只记是正式表还是测试表，不记表 ID / Base token（坑 11）。 */
  source: "prod" | "test"
  /** 已分配的最大 R 序号。 */
  seq: number
  counts: {
    records: number
    withScreenshots: number
    feishuEmpty: number
    shots: number
    transcribed: number
  }
  records: ReplayRecordSummary[]
}

export const REPLAY_STATUS_LABEL: Record<ReplayStatus, string> = {
  untested: "未测",
  tested: "已测",
  issue: "有问题",
}

export function statusLabel(status: ReplayStatus): string {
  return REPLAY_STATUS_LABEL[status] ?? REPLAY_STATUS_LABEL.untested
}

/** R001 起的三位编号。 */
export function rLabel(seq: number): string {
  return `R${String(seq).padStart(3, "0")}`
}

/** 页面/接口收到的 R 编号：只认 R001 这种，挡住拼路径的输入。 */
export function isValidReplayR(r: unknown): boolean {
  return typeof r === "string" && /^R\d{3,4}$/.test(r)
}

/** 「飞书为空」：问题描述、解决方案两列都为空（T26 验收用）。 */
export function isFeishuEmpty(problem: string | null | undefined, solution: string | null | undefined): boolean {
  return !String(problem ?? "").trim() && !String(solution ?? "").trim()
}

/**
 * 测试状态：T27 起由「最近一次核对过的运行」决定，实现在 replay-result.ts 的 deriveRunState
 * （跑过但没点「完成核对」仍算未测）。这里只保留状态类型和文案。
 */

export type NumberAssignment = {
  /** recordId → R 编号。 */
  numbers: Record<string, string>
  /** 分配后的最大序号。 */
  seqUsed: number
  /** 这次新分配的编号数。 */
  assigned: number
  /** 沿用 T25 导出的编号数。 */
  fromT25: number
  /** T25 编号已经被别的记录占用、只能重新编号的条数。 */
  conflicts: number
}

/**
 * 编号分配（D21：编号不变、新记录往后编）：
 *  1. 快照里已有的编号原样保留；
 *  2. 没有的，沿用它 T25 导出时的编号（若没被占用）；
 *  3. 剩下的按日期、recordId 排序，从当前最大号往后编。
 * 同一个 recordId 在多次刷新里永远拿到同一个编号。
 */
export function assignReplayNumbers(input: {
  existing: Record<string, string>
  t25: Record<string, number>
  incoming: { recordId: string; date: string }[]
  seqUsed: number
}): NumberAssignment {
  const numbers: Record<string, string> = {}
  const taken = new Set<string>()
  let fromT25 = 0
  let conflicts = 0

  // 先占住已有编号，避免新记录把它们顶掉。
  for (const [recordId, r] of Object.entries(input.existing)) {
    if (!/^R\d{3,}$/.test(r) || taken.has(r)) continue
    numbers[recordId] = r
    taken.add(r)
  }

  const pending: { recordId: string; date: string }[] = []
  for (const item of input.incoming) {
    if (numbers[item.recordId]) continue
    const seq = input.t25[item.recordId]
    if (seq && !taken.has(rLabel(seq))) {
      numbers[item.recordId] = rLabel(seq)
      taken.add(rLabel(seq))
      fromT25++
      continue
    }
    if (seq) conflicts++
    pending.push(item)
  }

  pending.sort((a, b) => a.date.localeCompare(b.date) || a.recordId.localeCompare(b.recordId))
  let seq = Math.max(input.seqUsed, 0)
  for (const item of pending) {
    do {
      seq++
    } while (taken.has(rLabel(seq)))
    numbers[item.recordId] = rLabel(seq)
    taken.add(rLabel(seq))
  }

  return { numbers, seqUsed: seq, assigned: pending.length, fromT25, conflicts }
}

export function summarizeRecords(details: ReplayRecordDetail[]): ReplayManifest["counts"] {
  const shots = details.reduce((n, d) => n + d.shots.length, 0)
  return {
    records: details.length,
    withScreenshots: details.filter((d) => d.shots.length > 0).length,
    feishuEmpty: details.filter((d) => isFeishuEmpty(d.problem, d.solution)).length,
    shots,
    transcribed: details.reduce((n, d) => n + d.shots.filter((s) => s.transcript).length, 0),
  }
}

/** 详情 → manifest 摘要（按 R 编号排序）。 */
export function toSummaries(details: ReplayRecordDetail[]): ReplayRecordSummary[] {
  return [...details]
    .sort((a, b) => a.r.localeCompare(b.r))
    .map((d) => ({
      r: d.r,
      recordId: d.recordId,
      title: d.title,
      date: d.date,
      customer: d.customer,
      screenshotCount: d.shots.length,
      feishuEmpty: isFeishuEmpty(d.problem, d.solution),
    }))
}

/** 「我的昵称」输入：逗号、顿号、分号、空格、换行都能分隔，去重保序。 */
export function parseNicknames(text: string): string[] {
  const out: string[] = []
  for (const raw of String(text ?? "").split(/[,，、;；\s]+/)) {
    const name = raw.trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

// ——— 列表筛选（页面上的搜索和几个开关，逻辑放这里才有单测） ——————

export type ReplayListRow = {
  r: string
  title: string
  customer: string
  date: string
  screenshotCount: number
  feishuEmpty: boolean
  status: ReplayStatus
  /** T27：有比最近一次核对过的运行更新的结果，还没点「完成核对」。 */
  pendingReview?: boolean
}

export type ReplayListFilter = {
  q: string
  status: ReplayStatus | "all"
  emptyOnly: boolean
  /** shots = 只显示带截图的（默认）；all = 全部 */
  scope: "shots" | "all"
}

export function emptyReplayFilter(): ReplayListFilter {
  return { q: "", status: "all", emptyOnly: false, scope: "shots" }
}

/** 搜索命中：R 编号、标题、客户、日期，多个词是「都要命中」。 */
export function filterReplayRows<T extends ReplayListRow>(rows: T[], filter: ReplayListFilter): T[] {
  const terms = String(filter.q ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  return rows.filter((row) => {
    if (filter.scope === "shots" && row.screenshotCount === 0) return false
    if (filter.status !== "all" && row.status !== filter.status) return false
    if (filter.emptyOnly && !row.feishuEmpty) return false
    if (!terms.length) return true
    const hay = [row.r, row.title, row.customer, row.date].join("\n").toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
}

export type ReplayRowCounts = {
  /** 全部记录数（「全部」这一段显示的就是它）。 */
  total: number
  /** 带截图的记录数（「带截图」这一段显示的就是它）。 */
  withScreenshots: number
  /** 下面三个数跟着当前范围走：带截图模式下只数带截图的记录。 */
  feishuEmpty: number
  byStatus: Record<ReplayStatus, number>
}

/**
 * 筛选按钮上的数字（11-24 用户反馈：「飞书为空」显示 16，列表里只有 11 条）。
 * 数字必须和当前范围一致：带截图模式只统计带截图的记录，全部模式才是全量。
 */
export function countReplayRows(rows: ReplayListRow[], scope: "shots" | "all"): ReplayRowCounts {
  const inScope = scope === "shots" ? rows.filter((r) => r.screenshotCount > 0) : rows
  const byStatus: Record<ReplayStatus, number> = { untested: 0, tested: 0, issue: 0 }
  for (const row of inScope) byStatus[row.status]++
  return {
    total: rows.length,
    withScreenshots: rows.filter((r) => r.screenshotCount > 0).length,
    feishuEmpty: inScope.filter((r) => r.feishuEmpty).length,
    byStatus,
  }
}

// ——— 费用与耗时估算（只输出数量，不带任何客户数据） ————————————

export type TokenAverage = { promptTokens: number; completionTokens: number; ms: number }

/** 从已缓存的转写里取平均用量，用来估算新图的费用和耗时；没有缓存时给保守默认值。 */
export function averageUsage(samples: TokenAverage[]): TokenAverage {
  const usable = samples.filter((s) => s.promptTokens > 0 || s.completionTokens > 0)
  if (!usable.length) return { promptTokens: 1100, completionTokens: 450, ms: 5000 }
  const sum = usable.reduce(
    (acc, s) => ({
      promptTokens: acc.promptTokens + s.promptTokens,
      completionTokens: acc.completionTokens + s.completionTokens,
      ms: acc.ms + (s.ms > 0 ? s.ms : 5000),
    }),
    { promptTokens: 0, completionTokens: 0, ms: 0 },
  )
  return {
    promptTokens: sum.promptTokens / usable.length,
    completionTokens: sum.completionTokens / usable.length,
    ms: sum.ms / usable.length,
  }
}

export type ReplayPlanNumbers = {
  source: "prod" | "test"
  /** 从飞书读到的记录数 / 附件数 / 图片数。 */
  tableRecords: number
  tableAttachments: number
  tableImages: number
  /** 现有快照。 */
  snapshotRecords: number
  snapshotShots: number
  /** 变化。 */
  newRecords: number
  newScreenshots: number
  /** 明细工作量。 */
  reuseScreenshots: number
  copyScreenshotFiles: number
  copyScreenshotBytes: number
  copyTranscriptFiles: number
  copyTranscriptBytes: number
  downloadRecords: number
  downloadImages: number
  transcribeImages: number
  /** 编号。 */
  nextR: string
  lastR: string
  numbersFromT25: number
  numbersAssigned: number
  numberConflicts: number
  /** 估算。 */
  estimatePromptTokens: number
  estimateCompletionTokens: number
  estimateCost: number | null
  estimateMinutes: number | null
  priceSource: string
  /** 只读指纹：刷新前后对比，证明没改飞书。 */
  fingerprint: string
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** 预览报告（只出数量，不出客户名和 ID）。 */
export function planReportLines(p: ReplayPlanNumbers): string[] {
  const lines: string[] = []
  lines.push(`来源表：${p.source === "prod" ? "正式表" : "测试表"}（只读）`)
  lines.push(`飞书里读到：${p.tableRecords} 条记录，${p.tableAttachments} 个附件（图片 ${p.tableImages}）`)
  lines.push(`现有快照：${p.snapshotRecords} 条记录，${p.snapshotShots} 张截图`)
  lines.push(`本次新增/变化：记录 ${p.newRecords} 条，截图 ${p.newScreenshots} 张`)
  lines.push(
    `截图处理：直接复用 ${p.reuseScreenshots} 张；从 T25 缓存复制 ${p.copyScreenshotFiles} 个文件（${formatBytes(p.copyScreenshotBytes)}）` +
      `、转写 ${p.copyTranscriptFiles} 份（${formatBytes(p.copyTranscriptBytes)}）`,
  )
  lines.push(`需要下载：${p.downloadRecords} 条记录 / ${p.downloadImages} 张图（T25 缓存里没有）`)
  lines.push(`需要转写：${p.transcribeImages} 张`)
  lines.push(
    `R 编号：沿用 T25 导出的 ${p.numbersFromT25} 个，本次新编 ${p.numbersAssigned} 个（到 ${p.lastR} 为止）` +
      `；以后的新记录从 ${p.nextR} 起${p.numberConflicts ? `（有 ${p.numberConflicts} 条 T25 编号冲突，已顺延）` : ""}`,
  )
  lines.push(
    p.estimateCost == null
      ? `预计费用：无法估算（${p.priceSource}）`
      : `预计费用：约 ${p.estimateCost.toFixed(2)} 元（${p.estimatePromptTokens} 输入 / ${p.estimateCompletionTokens} 输出 tokens，${p.priceSource}）`,
  )
  lines.push(
    p.estimateMinutes == null ? "预计耗时：无法估算" : `预计耗时：约 ${p.estimateMinutes} 分钟（转写，不含下载）`,
  )
  lines.push(`只读指纹：${p.fingerprint}（刷新前后对比，指纹不变说明飞书没被改）`)
  return lines
}
