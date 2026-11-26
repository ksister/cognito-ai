import { describe, expect, it } from "vitest"
import { MULTI_FIELD_KEYS } from "./feishu-schema"
import {
  REPLAY_MULTI_KEYS,
  compareReplayFields,
  countDiffs,
  deriveRunState,
  estimateReorganizeCost,
  estimateTokens,
  friendlyRunLabel,
  isBlankFieldReview,
  isLegacySpeakerRun,
  isReplayIssueType,
  isSafeRecordId,
  isValidRunId,
  lastReviewedRun,
  latestRun,
  newRunId,
  normalizeForCompare,
  normalizeLineMarks,
  parseReplayRun,
  replayFieldLabel,
  reviewHasIssue,
  runLabel,
  runTooltip,
  sortRunsNewestFirst,
  splitMultiValue,
  type ReplayFieldReview,
  type ReplayRun,
} from "./replay-result"

function run(over: Partial<ReplayRun> = {}): ReplayRun {
  const at = over.at ?? "2026-11-24T09:00:00.000Z"
  return {
    version: 1,
    runId: over.runId ?? newRunId(new Date(at), "abcd"),
    recordId: "recTEST",
    r: "R153",
    mode: "reorganize",
    at,
    durationMs: 12_000,
    model: "qwen-plus",
    promptVersion: "fields-v1",
    extractMode: "ai",
    usage: { promptTokens: 5000, completionTokens: 900 },
    costYuan: 0.01,
    transcript: "[OCR 转写，以截图为准]\n我：你好",
    fields: { title: "读码率低", problem: "现象", solution: "" },
    uncertain: [],
    review: null,
    ...over,
  }
}

function review(fields: Record<string, ReplayFieldReview>, reviewedAt: string | null = "2026-11-24T10:00:00.000Z") {
  return { fields, reviewedAt, updatedAt: reviewedAt ?? "2026-11-24T09:30:00.000Z" }
}

describe("多选 key 与表结构一致", () => {
  it("REPLAY_MULTI_KEYS 必须等于 feishu-schema 的 MULTI_FIELD_KEYS", () => {
    expect([...REPLAY_MULTI_KEYS]).toEqual([...MULTI_FIELD_KEYS])
  })
})

describe("compareReplayFields", () => {
  it("内容相同的字段标 same，不同的标 not same", () => {
    const rows = compareReplayFields({ title: "读码率低", problem: "现象" }, { title: "读码率低", problem: "现象与影响" }, [
      "title",
      "problem",
    ])
    expect(rows.map((r) => r.same)).toEqual([true, false])
    expect(rows[1].label).toBe("问题描述")
    expect(countDiffs(rows)).toBe(1)
  })

  it("只有空白和排版不同不算差异", () => {
    expect(normalizeForCompare("problem", "第一行\n第二行")).toBe(normalizeForCompare("problem", "第一行 第二行"))
    expect(normalizeForCompare("problem", "V4.3 读码")).toBe(normalizeForCompare("problem", "V4.3读码"))
  })

  it("多选字段：顺序和分隔符不同不算差异", () => {
    const rows = compareReplayFields({ dimensions: "2D 3D" }, { dimensions: "3D、2D" }, ["dimensions"])
    expect(rows[0].same).toBe(true)
  })

  it("多选字段：真的少了一个值才算差异", () => {
    const rows = compareReplayFields({ dimensions: "2D 3D" }, { dimensions: "2D" }, ["dimensions"])
    expect(rows[0].same).toBe(false)
  })

  it("左边为空、右边有内容算差异", () => {
    const rows = compareReplayFields({}, { title: "读码率低" }, ["title"])
    expect(rows[0].same).toBe(false)
  })

  it("未知字段用 key 当标签", () => {
    expect(replayFieldLabel("something_new")).toBe("something_new")
    const rows = compareReplayFields({ something_new: "a" }, { something_new: "b" }, ["something_new"])
    expect(rows[0].label).toBe("something_new")
  })

  it("splitMultiValue 认、，,;；/ 和空白", () => {
    expect(splitMultiValue("2D、3D 2D,3D;3D/2D")).toEqual(["2D", "3D", "2D", "3D", "3D", "2D"])
  })
})

describe("deriveRunState（T27 状态口径）", () => {
  it("没跑过 = 未测，不提示待核对", () => {
    expect(deriveRunState([])).toEqual({
      status: "untested",
      latestRunId: null,
      reviewedRunId: null,
      pendingReview: false,
    })
  })

  it("跑过但没点完成核对 = 未测 + 有新结果待核对", () => {
    const r = run()
    const state = deriveRunState([r])
    expect(state.status).toBe("untested")
    expect(state.pendingReview).toBe(true)
    expect(state.latestRunId).toBe(r.runId)
  })

  it("核对过、没有选问题类型 = 已测", () => {
    const r = run({ review: review({ title: { note: "标题可以短一点", issue: null } }) })
    expect(deriveRunState([r]).status).toBe("tested")
  })

  it("核对过、任一字段选了问题类型 = 有问题", () => {
    const r = run({ review: review({ problem: { note: "", issue: "missing" } }) })
    expect(deriveRunState([r]).status).toBe("issue")
  })

  it("只认最近一次核对过的运行：旧的没问题、新的有问题 = 有问题", () => {
    const older = run({ at: "2026-11-24T09:00:00.000Z", runId: "20261124T090000-aaaa", review: review({}) })
    const newer = run({ at: "2026-11-24T11:00:00.000Z", runId: "20261124T110000-bbbb", review: review({}) })
    const withIssue = { ...newer, review: review({ title: { note: "", issue: "misread" } }, "2026-11-24T12:00:00.000Z") }
    expect(deriveRunState([older, withIssue]).status).toBe("issue")
  })

  it("最近一次核对过的是旧运行、新运行还没核对 = 保持旧结论 + 提示待核对", () => {
    const older = run({
      at: "2026-11-24T09:00:00.000Z",
      runId: "20261124T090000-aaaa",
      review: review({}, "2026-11-24T09:30:00.000Z"),
    })
    const newer = run({ at: "2026-11-24T11:00:00.000Z", runId: "20261124T110000-bbbb", review: null })
    const state = deriveRunState([older, newer])
    expect(state.status).toBe("tested")
    expect(state.pendingReview).toBe(true)
    expect(state.reviewedRunId).toBe(older.runId)
  })

  it("跑过两次、都核对过 = 只看最近一次", () => {
    const older = run({
      at: "2026-11-24T09:00:00.000Z",
      runId: "20261124T090000-aaaa",
      review: review({}, "2026-11-24T09:30:00.000Z"),
    })
    const newer = run({
      at: "2026-11-24T11:00:00.000Z",
      runId: "20261124T110000-bbbb",
      review: review({ title: { note: "", issue: "speaker" } }, "2026-11-24T11:30:00.000Z"),
    })
    const state = deriveRunState([older, newer])
    expect(state.status).toBe("issue")
    expect(state.pendingReview).toBe(false)
    expect(state.reviewedRunId).toBe(newer.runId)
  })

  it("建议草稿保存了但没点完成核对，仍然算未测", () => {
    const r = run({ review: review({ title: { note: "先记一笔", issue: null } }, null) })
    expect(deriveRunState([r])).toMatchObject({ status: "untested", pendingReview: true, reviewedRunId: null })
  })
})

describe("review 判定", () => {
  it("reviewHasIssue 认四种问题类型，也认记录级的「发言人有误」「文字有误」", () => {
    expect(reviewHasIssue(null)).toBe(false)
    expect(reviewHasIssue({ fields: {}, reviewedAt: null, updatedAt: "" })).toBe(false)
    expect(reviewHasIssue({ fields: { a: { note: "", issue: "fabricated" } }, reviewedAt: null, updatedAt: "" })).toBe(true)
    expect(reviewHasIssue({ fields: {}, speakerError: true, reviewedAt: null, updatedAt: "" })).toBe(true)
    expect(reviewHasIssue({ fields: {}, textError: true, reviewedAt: null, updatedAt: "" })).toBe(true)
  })

  it("逐条标记：洗非法输入、同类型去重、支持「不是引用」", () => {
    const marks = normalizeLineMarks([
      { line: 2, type: "speaker", originalSpeaker: "客户", originalText: "a", newSpeaker: "我" },
      { line: 2, type: "speaker", originalSpeaker: "客户", originalText: "a", newSpeaker: "客户" },
      { line: 3, type: "unquote", originalSpeaker: "我", originalText: "b" },
      { line: 0, type: "text", originalSpeaker: "我", originalText: "c", newText: "d" },
      { line: 4, type: "bogus", originalSpeaker: "我", originalText: "e" },
    ])
    expect(marks).toHaveLength(2)
    expect(marks[0]).toMatchObject({ line: 2, type: "speaker", newSpeaker: "客户" })
    expect(marks[1]).toMatchObject({ line: 3, type: "unquote" })
  })

  it("有发言/文字逐条标记也算「有问题」", () => {
    const parsed = parseReplayRun({
      version: 1,
      runId: "20261124T090000-aaaa",
      recordId: "recTEST",
      r: "R079",
      mode: "retranscribe",
      at: "2026-11-24T09:00:00.000Z",
      fields: {},
      review: {
        fields: {},
        lineMarks: [
          { line: 1, type: "speaker", originalSpeaker: "客户", originalText: "a", newSpeaker: "我" },
          { line: 2, type: "extra", originalSpeaker: "客户", originalText: "b" },
        ],
        reviewedAt: "2026-11-24T10:00:00.000Z",
        updatedAt: "2026-11-24T10:00:00.000Z",
      },
    })
    expect(parsed?.review?.lineMarks).toHaveLength(2)
    expect(deriveRunState([parsed!]).status).toBe("issue")
  })

  it("「文字有误」+ 错几处 + 备注 会存在 review 里", () => {
    const parsed = parseReplayRun({
      version: 1,
      runId: "20261124T090000-aaaa",
      recordId: "recTEST",
      r: "R060",
      mode: "retranscribe",
      at: "2026-11-24T09:00:00.000Z",
      fields: {},
      review: {
        fields: {},
        textError: true,
        textErrorCount: 1,
        textErrorNote: "「闪退有哪天」被转成「闪退有哪」，漏了一个字",
        reviewedAt: "2026-11-24T10:00:00.000Z",
        updatedAt: "2026-11-24T10:00:00.000Z",
      },
    })
    expect(parsed?.review?.textError).toBe(true)
    expect(parsed?.review?.textErrorCount).toBe(1)
    expect(parsed?.review?.textErrorNote).toContain("漏了一个字")
    expect(deriveRunState([parsed!]).status).toBe("issue")
  })

  it("「发言人有误」+ 错几条 会存在 review 里，并让状态变成有问题", () => {
    const parsed = parseReplayRun({
      version: 1,
      runId: "20261124T090000-aaaa",
      recordId: "recTEST",
      r: "R153",
      mode: "retranscribe",
      at: "2026-11-24T09:00:00.000Z",
      fields: {},
      review: {
        fields: {},
        speakerError: true,
        speakerErrorCount: 5,
        reviewedAt: "2026-11-24T10:00:00.000Z",
        updatedAt: "2026-11-24T10:00:00.000Z",
      },
    })
    expect(parsed?.review?.speakerError).toBe(true)
    expect(parsed?.review?.speakerErrorCount).toBe(5)
    expect(deriveRunState([parsed!]).status).toBe("issue")
  })

  it("isReplayIssueType 挡住乱写的值", () => {
    expect(isReplayIssueType("misread")).toBe(true)
    expect(isReplayIssueType("other")).toBe(false)
    expect(isReplayIssueType(null)).toBe(false)
  })

  it("空建议空问题类型的字段算空白（存盘时删掉）", () => {
    expect(isBlankFieldReview({ note: "  ", issue: null })).toBe(true)
    expect(isBlankFieldReview({ note: "", issue: "missing" })).toBe(false)
    expect(isBlankFieldReview({ note: "写得再清楚点", issue: null })).toBe(false)
  })
})

describe("运行历史排序", () => {
  it("新的在前，时间相同按 runId 稳定排序", () => {
    const a = run({ at: "2026-11-24T09:00:00.000Z", runId: "20261124T090000-aaaa" })
    const b = run({ at: "2026-11-24T11:00:00.000Z", runId: "20261124T110000-bbbb" })
    const c = run({ at: "2026-11-24T11:00:00.000Z", runId: "20261124T110000-cccc" })
    expect(sortRunsNewestFirst([a, b, c]).map((r) => r.runId)).toEqual([c.runId, b.runId, a.runId])
    expect(latestRun([a, b, c])?.runId).toBe(c.runId)
  })

  it("lastReviewedRun 取最近核对过的", () => {
    const older = run({ at: "2026-11-24T09:00:00.000Z", runId: "20261124T090000-aaaa", review: review({}, "2026-11-24T09:10:00.000Z") })
    const newer = run({ at: "2026-11-24T11:00:00.000Z", runId: "20261124T110000-bbbb", review: null })
    expect(lastReviewedRun([newer, older])?.runId).toBe(older.runId)
  })
})

describe("newRunId / runLabel", () => {  it("格式固定、可用作文件名、能按时间排序", () => {
    const a = newRunId(new Date("2026-11-24T09:05:12.000Z"), "a1b2")
    const b = newRunId(new Date("2026-11-24T09:05:13.000Z"), "a1b2")
    expect(a).toBe("20261124T090512-a1b2")
    expect(isValidRunId(a)).toBe(true)
    expect(a.localeCompare(b)).toBeLessThan(0)
    expect(/[\\/:*?"<>|]/.test(a)).toBe(false)
  })

  it("随机后缀也符合格式", () => {
    for (let i = 0; i < 20; i++) expect(isValidRunId(newRunId())).toBe(true)
  })

  it("挡住了路径穿越式的名字", () => {
    expect(isValidRunId("../evil")).toBe(false)
  })
})

describe("isSafeRecordId（拼路径前必须过）", () => {
  it("正常的飞书记录 ID 通过", () => {
    expect(isSafeRecordId("recvllXbSeV9QD")).toBe(true)
    expect(isSafeRecordId("rec_a-1")).toBe(true)
  })

  it("路径穿越、空格、空串、超长都不行", () => {
    expect(isSafeRecordId("../evil")).toBe(false)
    expect(isSafeRecordId("rec/../evil")).toBe(false)
    expect(isSafeRecordId("..\\evil")).toBe(false)
    expect(isSafeRecordId("rec evil")).toBe(false)
    expect(isSafeRecordId("")).toBe(false)
    expect(isSafeRecordId(null)).toBe(false)
    expect(isSafeRecordId("a".repeat(81))).toBe(false)
  })

  it("历史文案带模式、模型、提示词版本和核对状态", () => {
    const label = runLabel(run({ review: review({}) }))
    expect(label).toContain("只重跑整理")
    expect(label).toContain("qwen-plus")
    expect(label).toContain("fields-v1")
    expect(label).toContain("已核对")
  })

  it("下拉里的大白话：时间 + 模式 + 第几次", () => {
    // 不写死时区：按本机时区算出期望值（CI 在 UTC，本机在 +08:00）。
    const pad = (n: number) => String(n).padStart(2, "0")
    const local = (iso: string) => {
      const d = new Date(iso)
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    const r = run({ at: "2026-11-24T09:51:22.000Z", mode: "retranscribe" })
    expect(friendlyRunLabel(r, 2)).toBe(`${local(r.at)} · 重新看图转写（第 2 次）`)
    const reorg = run({ at: "2026-11-24T09:00:00.000Z", mode: "reorganize" })
    expect(friendlyRunLabel(reorg, 1)).toBe(`${local(reorg.at)} · 只重跑整理（第 1 次）`)
    // 形状固定：MM-DD HH:MM · 模式（第 N 次）
    expect(friendlyRunLabel(r, 2)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2} · 重新看图转写（第 2 次）$/)
  })

  it("悬停提示写模型、提示词版本、耗时、费用和核对状态", () => {
    const tip = runTooltip(
      run({ review: review({}), promptVersion: "fields-v1", transcriptPromptVersion: "transcript-v1", durationMs: 10_100, costYuan: 0.0038 }),
    )
    expect(tip).toContain("qwen-plus")
    expect(tip).toContain("fields-v1 + transcript-v1")
    expect(tip).toContain("10.1 秒")
    expect(tip).toContain("0.0038 元")
    expect(tip).toContain("已核对")
  })

  it("「旧规则」判定：没有 rawSpeaker 的转写结果算旧规则，整理结果和带 rawSpeaker 的不算", () => {
    expect(isLegacySpeakerRun(run({ mode: "retranscribe", turns: [{ speaker: "我", text: "好", kind: "speech" }] }))).toBe(true)
    expect(
      isLegacySpeakerRun(run({ mode: "retranscribe", turns: [{ speaker: "我", text: "好", kind: "speech", rawSpeaker: "张珂" }] })),
    ).toBe(false)
    expect(isLegacySpeakerRun(run({ mode: "reorganize", turns: undefined }))).toBe(false)
    expect(isLegacySpeakerRun(run({ mode: "retranscribe", turns: [] }))).toBe(true)
  })

  it("从截图重新转写会同时显示两个提示词版本", () => {
    const label = runLabel(run({ mode: "retranscribe", transcriptPromptVersion: "transcript-v1" }))
    expect(label).toContain("从截图重新转写")
    expect(label).toContain("transcript-v1")
  })
})

describe("费用估算", () => {
  const price = { input: 0.8, output: 2, priced: true }

  it("token 按 1.2 字 ≈ 1 token 折算，单调不减", () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(1200)).toBe(1000)
    expect(estimateTokens(1201)).toBe(1001)
  })

  it("有单价时给出金额：输入 + 输出", () => {
    const cost = estimateReorganizeCost({ transcriptChars: 12_000, systemChars: 6_000, price, pricesUpdatedAt: "2026-11-09" })
    // 输入 = 6000/1.2 + 2*(12000/1.2) = 25000；输出 1200
    expect(cost.promptTokens).toBe(25_000)
    expect(cost.completionTokens).toBe(1200)
    expect(cost.costYuan).toBeCloseTo(25_000 / 1e6 * 0.8 + 1200 / 1e6 * 2, 10)
    expect(cost.priceNote).toContain("2026-11-09")
  })

  it("没有单价时不算金额，只说需要核实", () => {
    const cost = estimateReorganizeCost({ transcriptChars: 100, systemChars: 100, price: null })
    expect(cost.costYuan).toBeNull()
    expect(cost.priceNote).toContain("单价")
  })
})
