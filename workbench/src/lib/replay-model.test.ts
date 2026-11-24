import { describe, expect, it } from "vitest"
import {
  assignReplayNumbers,
  averageUsage,
  deriveReplayStatus,
  emptyReplayFilter,
  filterReplayRows,
  formatBytes,
  isFeishuEmpty,
  parseNicknames,
  planReportLines,
  rLabel,
  statusLabel,
  summarizeRecords,
  toSummaries,
  type ReplayListRow,
  type ReplayPlanNumbers,
  type ReplayRecordDetail,
} from "./replay-model"

const detail = (over: Partial<ReplayRecordDetail>): ReplayRecordDetail => ({
  r: "R001",
  recordId: "recA",
  title: "标题",
  date: "2026-01-01",
  customer: "示例客户",
  localId: "",
  problem: "问题",
  solution: "解决",
  attachments: [],
  shots: [],
  numberSource: "new",
  importedAt: "2026-01-01T00:00:00.000Z",
  ...over,
})

describe("isFeishuEmpty", () => {
  it("两列都空才算飞书为空", () => {
    expect(isFeishuEmpty("", "")).toBe(true)
    expect(isFeishuEmpty("  ", "\n")).toBe(true)
    expect(isFeishuEmpty(null, undefined)).toBe(true)
    expect(isFeishuEmpty("有描述", "")).toBe(false)
    expect(isFeishuEmpty("", "有方案")).toBe(false)
  })
})

describe("rLabel", () => {
  it("三位补零，超过三位不截断", () => {
    expect(rLabel(1)).toBe("R001")
    expect(rLabel(169)).toBe("R169")
    expect(rLabel(1000)).toBe("R1000")
  })
})

describe("assignReplayNumbers", () => {
  const incoming = [
    { recordId: "recA", date: "2026-01-01" },
    { recordId: "recB", date: "2026-02-01" },
    { recordId: "recC", date: "2026-03-01" },
  ]

  it("已有编号原样保留", () => {
    const out = assignReplayNumbers({
      existing: { recA: "R005" },
      t25: {},
      incoming,
      seqUsed: 5,
    })
    expect(out.numbers.recA).toBe("R005")
    expect(out.numbers.recB).toBe("R006")
    expect(out.numbers.recC).toBe("R007")
    expect(out.seqUsed).toBe(7)
    expect(out.assigned).toBe(2)
  })

  it("继续沿用 T25 导出的编号", () => {
    const out = assignReplayNumbers({
      existing: { recA: "R001" },
      t25: { recB: 42 },
      incoming,
      seqUsed: 42,
    })
    expect(out.numbers.recB).toBe("R042")
    expect(out.fromT25).toBe(1)
    expect(out.numbers.recC).toBe("R043")
  })

  it("T25 编号被别的记录占用时顺延，不覆盖", () => {
    const out = assignReplayNumbers({
      existing: { recA: "R042" },
      t25: { recB: 42 },
      incoming,
      seqUsed: 42,
    })
    expect(out.numbers.recA).toBe("R042")
    expect(out.numbers.recB).not.toBe("R042")
    expect(out.conflicts).toBe(1)
  })

  it("新记录按日期排序往后编", () => {
    const out = assignReplayNumbers({
      existing: {},
      t25: {},
      incoming: [
        { recordId: "recZ", date: "2026-03-01" },
        { recordId: "recX", date: "2026-01-15" },
        { recordId: "recY", date: "2026-02-01" },
      ],
      seqUsed: 0,
    })
    expect(out.numbers).toEqual({ recX: "R001", recY: "R002", recZ: "R003" })
  })

  it("同一批记录重复分配拿到同一个编号（刷新不跳号）", () => {
    const first = assignReplayNumbers({ existing: {}, t25: {}, incoming, seqUsed: 0 })
    const second = assignReplayNumbers({ existing: first.numbers, t25: {}, incoming, seqUsed: first.seqUsed })
    expect(second.numbers).toEqual(first.numbers)
    expect(second.assigned).toBe(0)
    expect(second.seqUsed).toBe(first.seqUsed)
  })

  it("非法旧编号不会被当成编号占位", () => {
    const out = assignReplayNumbers({
      existing: { recA: "编号坏了" },
      t25: {},
      incoming,
      seqUsed: 3,
    })
    expect(out.numbers.recA).toBe("R004")
  })
})

describe("deriveReplayStatus", () => {
  it("没跑过是未测", () => {
    expect(deriveReplayStatus([])).toBe("untested")
    expect(statusLabel("untested")).toBe("未测")
  })
  it("跑过没标问题算已测，标了问题算有问题", () => {
    expect(deriveReplayStatus([{}, { issues: [] }])).toBe("tested")
    expect(deriveReplayStatus([{ issues: ["漏了信息"] }])).toBe("issue")
  })
})

describe("parseNicknames", () => {
  it("逗号、顿号、分号、空格都能分隔，去重保序", () => {
    expect(parseNicknames("张三、小张，张工; 张三")).toEqual(["张三", "小张", "张工"])
    expect(parseNicknames("   ")).toEqual([])
    expect(parseNicknames("A B")).toEqual(["A", "B"])
  })
})

describe("summarize / toSummaries", () => {
  it("统计条数、带截图数、飞书为空、截图数", () => {
    const details = [
      detail({ r: "R002", recordId: "b", problem: "", solution: "", shots: [{ hash: "h1", file: "media/h1.jpg", transcript: "transcripts/h1.json", isChat: true }] }),
      detail({ r: "R001", recordId: "a", shots: [] }),
    ]
    const counts = summarizeRecords(details)
    expect(counts.records).toBe(2)
    expect(counts.withScreenshots).toBe(1)
    expect(counts.feishuEmpty).toBe(1)
    expect(counts.shots).toBe(1)
    expect(toSummaries(details).map((s) => s.r)).toEqual(["R001", "R002"])
  })
})

describe("averageUsage", () => {
  it("没有样本时给保守默认值", () => {
    expect(averageUsage([])).toEqual({ promptTokens: 1100, completionTokens: 450, ms: 5000 })
  })
  it("按样本求平均", () => {
    const avg = averageUsage([
      { promptTokens: 1000, completionTokens: 400, ms: 4000 },
      { promptTokens: 2000, completionTokens: 600, ms: 6000 },
    ])
    expect(avg).toEqual({ promptTokens: 1500, completionTokens: 500, ms: 5000 })
  })
})

describe("filterReplayRows", () => {
  const rows: ReplayListRow[] = [
    { r: "R001", title: "百分位裁切", customer: "示例客户甲", date: "2026-01-05", screenshotCount: 2, feishuEmpty: false, status: "untested" },
    { r: "R002", title: "分页表格刷新", customer: "示例客户乙", date: "2026-02-06", screenshotCount: 0, feishuEmpty: true, status: "untested" },
    { r: "R003", title: "读码率低", customer: "示例客户甲", date: "2026-03-07", screenshotCount: 1, feishuEmpty: false, status: "issue" },
  ]
  const base = emptyReplayFilter()

  it("默认只显示带截图的", () => {
    expect(filterReplayRows(rows, base).map((r) => r.r)).toEqual(["R001", "R003"])
    expect(filterReplayRows(rows, { ...base, scope: "all" }).map((r) => r.r)).toEqual(["R001", "R002", "R003"])
  })

  it("「飞书为空」只留两列都空的", () => {
    expect(filterReplayRows(rows, { ...base, scope: "all", emptyOnly: true }).map((r) => r.r)).toEqual(["R002"])
  })

  it("状态筛选", () => {
    expect(filterReplayRows(rows, { ...base, status: "issue" }).map((r) => r.r)).toEqual(["R003"])
    expect(filterReplayRows(rows, { ...base, status: "tested" })).toEqual([])
  })

  it("搜索覆盖 R 编号、标题、客户、日期，多词都要命中", () => {
    expect(filterReplayRows(rows, { ...base, scope: "all", q: "R002" }).map((r) => r.r)).toEqual(["R002"])
    expect(filterReplayRows(rows, { ...base, q: "读码" }).map((r) => r.r)).toEqual(["R003"])
    expect(filterReplayRows(rows, { ...base, q: "示例客户甲" }).map((r) => r.r)).toEqual(["R001", "R003"])
    expect(filterReplayRows(rows, { ...base, scope: "all", q: "2026-02" }).map((r) => r.r)).toEqual(["R002"])
    expect(filterReplayRows(rows, { ...base, q: "示例客户甲 裁切" }).map((r) => r.r)).toEqual(["R001"])
    expect(filterReplayRows(rows, { ...base, q: "示例客户甲 读码率低 2026-01" })).toEqual([])
  })

  it("大小写和空格不影响", () => {
    expect(filterReplayRows(rows, { ...base, q: "  r00  " }).map((r) => r.r)).toEqual(["R001", "R003"])
    expect(filterReplayRows(rows, { ...base, q: " r001 " }).map((r) => r.r)).toEqual(["R001"])
  })
})

describe("planReportLines", () => {
  const numbers: ReplayPlanNumbers = {
    source: "prod",
    tableRecords: 350,
    tableAttachments: 542,
    tableImages: 541,
    snapshotRecords: 169,
    snapshotShots: 401,
    newRecords: 181,
    newScreenshots: 140,
    reuseScreenshots: 401,
    copyScreenshotFiles: 0,
    copyScreenshotBytes: 0,
    copyTranscriptFiles: 0,
    copyTranscriptBytes: 0,
    downloadRecords: 36,
    downloadImages: 140,
    transcribeImages: 140,
    nextR: "R170",
    lastR: "R169",
    numbersFromT25: 169,
    numbersAssigned: 0,
    numberConflicts: 0,
    estimatePromptTokens: 154000,
    estimateCompletionTokens: 63000,
    estimateCost: 0.29,
    estimateMinutes: 3,
    priceSource: "2026-11-09 的 KB_DIR/config/model-prices.json",
    fingerprint: "0123456789abcdef",
  }

  it("报告只有数量和费用，不出现飞书记录 ID", () => {
    const text = planReportLines(numbers).join("\n")
    expect(text).toContain("350")
    expect(text).toContain("140")
    expect(text).toContain("0.29")
    expect(text).not.toMatch(/\brec[A-Za-z0-9]{6,}/)
    expect(text).not.toMatch(/\btbl[A-Za-z0-9]{6,}/)
    expect(text).not.toContain("示例客户")
  })

  it("单价为空时明确说不估算，不编数字", () => {
    const text = planReportLines({ ...numbers, estimateCost: null, priceSource: "model-prices.json 里没有单价" }).join("\n")
    expect(text).toContain("预计费用：无法估算")
  })

  it("formatBytes 用中文单位", () => {
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(2048)).toBe("2 KB")
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB")
  })
})
