import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  listRecordIdsWithResults,
  listRuns,
  readRun,
  readRunStates,
  recordResultsDir,
  runFilePath,
  saveRunReview,
  writeRun,
} from "./replay-results-store"
import { newRunId, type ReplayRun } from "./replay-result"
import { resultsDir } from "./replay-store"

let root = ""

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "replay-results-test-"))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function run(over: Partial<ReplayRun> = {}): ReplayRun {
  const at = over.at ?? "2026-11-24T09:00:00.000Z"
  return {
    version: 1,
    runId: over.runId ?? newRunId(new Date(at), "aaaa"),
    recordId: over.recordId ?? "recTESTSAFE",
    r: "R002",
    mode: "reorganize",
    at,
    durationMs: 1000,
    model: "test-model",
    promptVersion: "fields-v1",
    extractMode: "ai",
    usage: { promptTokens: 1, completionTokens: 1 },
    costYuan: 0.001,
    transcript: "[OCR 转写，以截图为准]\n我：你好",
    fields: { title: "虚构标题", problem: "虚构问题" },
    uncertain: [],
    review: null,
    ...over,
  }
}

describe("路径校验（防 ../ 穿越）", () => {
  it("记录目录只接受字母数字和 _-", () => {
    expect(() => recordResultsDir(root, "../evil")).toThrow()
    expect(() => recordResultsDir(root, "rec/../evil")).toThrow()
    expect(() => recordResultsDir(root, "..\\evil")).toThrow()
    expect(() => recordResultsDir(root, "a b")).toThrow()
    expect(() => recordResultsDir(root, "")).toThrow()
    expect(recordResultsDir(root, "recTESTSAFE")).toContain("recTESTSAFE")
  })

  it("运行文件只接受固定格式的 runId", () => {
    expect(() => runFilePath(root, "recTESTSAFE", "../evil")).toThrow()
    expect(() => runFilePath(root, "recTESTSAFE", "2026-11-24")).toThrow()
    expect(runFilePath(root, "recTESTSAFE", "20261124T090000-aaaa")).toContain("20261124T090000-aaaa.json")
  })

  it("读盘时坏 ID 只返回 null，不抛错", async () => {
    expect(await readRun(root, "../evil", "20261124T090000-aaaa")).toBeNull()
    expect(await readRun(root, "recTESTSAFE", "../evil")).toBeNull()
  })

  it("保存核对时坏 ID 返回错误，不写盘", async () => {
    const bad = await saveRunReview({ kbDir: root, recordId: "../evil", runId: "20261124T090000-aaaa", fields: {}, reviewed: true })
    expect(bad.ok).toBe(false)
    const badRun = await saveRunReview({ kbDir: root, recordId: "recTESTSAFE", runId: "../evil", fields: {}, reviewed: true })
    expect(badRun.ok).toBe(false)
  })
})

describe("读写结果", () => {
  it("写进去能读回来，字段和 review 都保留", async () => {
    const kb = path.join(root, "kb-roundtrip")
    const r = run({ recordId: "recROUNDTRIP" })
    await writeRun(kb, r)
    const back = await readRun(kb, r.recordId, r.runId)
    expect(back?.runId).toBe(r.runId)
    expect(back?.fields.title).toBe("虚构标题")
    expect(back?.review).toBeNull()
  })

  it("建议存得住：不点完成核对时 reviewedAt 仍是 null", async () => {
    const kb = path.join(root, "kb-draft")
    const r = run({ recordId: "recDRAFT" })
    await writeRun(kb, r)
    const saved = await saveRunReview({
      kbDir: kb,
      recordId: r.recordId,
      runId: r.runId,
      fields: { title: { note: "标题可以短一点", issue: null } },
      reviewed: false,
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.run.review?.reviewedAt).toBeNull()
    expect(saved.run.review?.fields.title.note).toBe("标题可以短一点")
    const back = await readRun(kb, r.recordId, r.runId)
    expect(back?.review?.reviewedAt).toBeNull()
  })

  it("点完成核对写 reviewedAt，再存建议不会把它清掉", async () => {
    const kb = path.join(root, "kb-reviewed")
    const r = run({ recordId: "recREVIEWED" })
    await writeRun(kb, r)
    const first = await saveRunReview({
      kbDir: kb,
      recordId: r.recordId,
      runId: r.runId,
      fields: { problem: { note: "", issue: "missing" } },
      reviewed: true,
      at: new Date("2026-11-24T10:00:00.000Z"),
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const reviewedAt = first.run.review?.reviewedAt
    expect(reviewedAt).toBe("2026-11-24T10:00:00.000Z")

    const second = await saveRunReview({
      kbDir: kb,
      recordId: r.recordId,
      runId: r.runId,
      fields: { problem: { note: "再补一句", issue: "missing" } },
      reviewed: false,
      at: new Date("2026-11-24T10:05:00.000Z"),
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.run.review?.reviewedAt).toBe(reviewedAt)
  })

  it("空白建议和乱写的问题类型不会存进去", async () => {
    const kb = path.join(root, "kb-clean")
    const r = run({ recordId: "recCLEAN" })
    await writeRun(kb, r)
    const saved = await saveRunReview({
      kbDir: kb,
      recordId: r.recordId,
      runId: r.runId,
      fields: { title: { note: "   ", issue: null }, problem: { note: "", issue: "不存在的类型" } },
      reviewed: false,
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(Object.keys(saved.run.review?.fields ?? {})).toEqual([])
  })

  it("历史按时间新的在前，坏文件跳过", async () => {
    const kb = path.join(root, "kb-history")
    const oldRun = run({ recordId: "recHIST", at: "2026-11-24T09:00:00.000Z", runId: "20261124T090000-aaaa" })
    const newRun = run({ recordId: "recHIST", at: "2026-11-24T11:00:00.000Z", runId: "20261124T110000-bbbb" })
    await writeRun(kb, oldRun)
    await writeRun(kb, newRun)
    await fs.writeFile(path.join(recordResultsDir(kb, "recHIST"), "20261124T120000-cccc.json"), "{ 坏 JSON", "utf8")
    const runs = await listRuns(kb, "recHIST")
    expect(runs.map((r) => r.runId)).toEqual([newRun.runId, oldRun.runId])
  })
})

describe("状态汇总", () => {
  it("跑过没核对 = 未测 + 待核对；核对后按最近一次算", async () => {
    const kb = path.join(root, "kb-states")
    const a = run({ recordId: "recSTATE", at: "2026-11-24T09:00:00.000Z", runId: "20261124T090000-aaaa" })
    await writeRun(kb, a)
    let states = await readRunStates(kb)
    expect(states.get("recSTATE")?.status).toBe("untested")
    expect(states.get("recSTATE")?.pendingReview).toBe(true)

    await saveRunReview({ kbDir: kb, recordId: "recSTATE", runId: a.runId, fields: {}, reviewed: true })
    states = await readRunStates(kb)
    expect(states.get("recSTATE")?.status).toBe("tested")
    expect(states.get("recSTATE")?.pendingReview).toBe(false)

    const b = run({ recordId: "recSTATE", at: "2026-11-24T11:00:00.000Z", runId: "20261124T110000-bbbb" })
    await writeRun(kb, b)
    states = await readRunStates(kb)
    expect(states.get("recSTATE")?.status).toBe("tested")
    expect(states.get("recSTATE")?.pendingReview).toBe(true)

    await saveRunReview({
      kbDir: kb,
      recordId: "recSTATE",
      runId: b.runId,
      fields: { title: { note: "", issue: "fabricated" } },
      reviewed: true,
    })
    states = await readRunStates(kb)
    expect(states.get("recSTATE")?.status).toBe("issue")
  })

  it("只扫 results 目录，_archive 里的存档不算结果", async () => {
    const kb = path.join(root, "kb-archive")
    const archived = path.join(kb, "replay", "_archive", "selftest", "recOLD")
    await fs.mkdir(archived, { recursive: true })
    await fs.writeFile(path.join(archived, "20261124T090000-aaaa.json"), JSON.stringify(run({ recordId: "recOLD" })), "utf8")
    expect(await listRecordIdsWithResults(kb)).toEqual([])
    expect((await readRunStates(kb)).size).toBe(0)
    expect(resultsDir(kb).endsWith(path.join("replay", "results"))).toBe(true)
  })
})
