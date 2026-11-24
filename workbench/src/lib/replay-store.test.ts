import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  cachedImageFile,
  cachedTranscriptFile,
  importMediaFrom,
  importTranscriptFrom,
  loadT25Cache,
  mediaDir,
  readReplayManifest,
  recordDetailPath,
  resultsDir,
  snapshotDir,
  snapshotFileExists,
  t25SeqMap,
  transcriptsDir,
  writeRecordDetail,
  writeReplayManifest,
} from "./replay-store"
import { listRuns } from "./replay-results-store"
import type { ReplayManifest } from "./replay-model"

let root = ""

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "replay-store-test-"))
})

afterAll(async () => {
  // 测试自己的临时目录，清理掉。
  await fs.rm(root, { recursive: true, force: true })
})

const manifest: ReplayManifest = {
  version: 1,
  updatedAt: "2026-11-24T00:00:00.000Z",
  source: "prod",
  seq: 169,
  counts: { records: 1, withScreenshots: 1, feishuEmpty: 0, shots: 1, transcribed: 1 },
  records: [
    { r: "R001", recordId: "recA", title: "标题", date: "2026-01-01", customer: "示例客户", screenshotCount: 1, feishuEmpty: false },
  ],
}

describe("manifest 读写", () => {
  it("没有快照时返回 null，不报错", async () => {
    const kb = path.join(root, "kb-empty")
    const state = await readReplayManifest(kb)
    expect(state).toEqual({ ok: true, manifest: null })
  })

  it("写进去能读回来", async () => {
    const kb = path.join(root, "kb-ok")
    await writeReplayManifest(kb, manifest)
    const state = await readReplayManifest(kb)
    expect(state.ok).toBe(true)
    if (state.ok) expect(state.manifest?.records[0].r).toBe("R001")
  })

  it("文件坏了给出明确错误，不静默当成空快照", async () => {
    const kb = path.join(root, "kb-broken")
    await fs.mkdir(snapshotDir(kb), { recursive: true })
    await fs.writeFile(path.join(snapshotDir(kb), "manifest.json"), "{ 坏掉的 json", "utf8")
    const state = await readReplayManifest(kb)
    expect(state.ok).toBe(false)
    if (!state.ok) expect(state.error).toContain("损坏")
  })

  it("详情按 R 编号分文件", async () => {
    const kb = path.join(root, "kb-detail")
    await writeRecordDetail(kb, {
      r: "R001",
      recordId: "recA",
      title: "标题",
      date: "2026-01-01",
      customer: "示例客户",
      localId: "",
      problem: "p",
      solution: "",
      attachments: [],
      shots: [],
      numberSource: "new",
      importedAt: "2026-11-24T00:00:00.000Z",
    })
    expect(recordDetailPath(kb, "R001")).toBe(path.join(snapshotDir(kb), "records", "R001.json"))
    const stat = await fs.stat(recordDetailPath(kb, "R001"))
    expect(stat.size).toBeGreaterThan(0)
    expect(snapshotFileExists(kb, "records/R001.json")).toBe(true)
    expect(snapshotFileExists(kb, "records/R002.json")).toBe(false)
  })
})

describe("截图与转写按内容哈希去重", () => {
  it("同一张图只存一份，第二次 copied=false", async () => {
    const kb = path.join(root, "kb-media")
    const src = path.join(root, "shot-a.png")
    await fs.writeFile(src, Buffer.from("png-bytes-a"))
    const first = await importMediaFrom({ sourceFile: src, kbDir: kb })
    const second = await importMediaFrom({ sourceFile: src, kbDir: kb })
    expect(first.hash).toBe(second.hash)
    expect(first.copied).toBe(true)
    expect(second.copied).toBe(false)
    expect(first.file).toBe(`media/${first.hash}.png`)
    const files = await fs.readdir(mediaDir(kb))
    expect(files).toHaveLength(1)
  })

  it("内容不同就是两个文件", async () => {
    const kb = path.join(root, "kb-media2")
    const a = path.join(root, "shot-b.png")
    const b = path.join(root, "shot-c.png")
    await fs.writeFile(a, Buffer.from("aaa"))
    await fs.writeFile(b, Buffer.from("bbb"))
    const one = await importMediaFrom({ sourceFile: a, kbDir: kb })
    const two = await importMediaFrom({ sourceFile: b, kbDir: kb })
    expect(one.hash).not.toBe(two.hash)
    expect(await fs.readdir(mediaDir(kb))).toHaveLength(2)
  })

  it("转写文件按截图哈希去重", async () => {
    const kb = path.join(root, "kb-transcript")
    const src = path.join(root, "t.json")
    await fs.writeFile(src, JSON.stringify({ isChat: true, turns: [] }), "utf8")
    const first = await importTranscriptFrom({ sourceFile: src, kbDir: kb, hash: "abc" })
    const second = await importTranscriptFrom({ sourceFile: src, kbDir: kb, hash: "abc" })
    expect(first.file).toBe("transcripts/abc.json")
    expect(first.copied).toBe(true)
    expect(second.copied).toBe(false)
    expect(await fs.readdir(transcriptsDir(kb))).toEqual(["abc.json"])
  })
})

describe("T25 缓存", () => {
  it("没有 index.json 时返回 null（快照不依赖它）", async () => {
    expect(await loadT25Cache(path.join(root, "no-such-work"))).toBeNull()
  })

  it("按 recordId + token 找到缓存的图和转写", async () => {
    const work = path.join(root, "t25-work")
    await fs.mkdir(path.join(work, "images", "recA"), { recursive: true })
    await fs.mkdir(path.join(work, "transcripts"), { recursive: true })
    await fs.writeFile(path.join(work, "images", "recA", "01-tok1.png"), Buffer.from("x"))
    await fs.writeFile(path.join(work, "transcripts", "tok1.json"), "{}", "utf8")
    await fs.writeFile(
      path.join(work, "index.json"),
      JSON.stringify({
        records: { recA: { seq: 7, attachments: [{ token: "tok1", file: "images/recA/01-tok1.png" }] } },
      }),
      "utf8",
    )
    const cache = await loadT25Cache(work)
    expect(cache).not.toBeNull()
    expect(cachedImageFile(cache, "recA", "tok1")).toContain("01-tok1.png")
    expect(cachedImageFile(cache, "recA", "tok-不存在")).toBeNull()
    expect(cachedTranscriptFile(cache, "tok1")).toContain("tok1.json")
    expect(t25SeqMap(cache)).toEqual({ recA: 7 })
  })
})

describe("results 目录", () => {
  it("没有结果目录时读出来是空列表", async () => {
    const kb = path.join(root, "kb-no-results")
    expect(await listRuns(kb, "recA")).toEqual([])
  })

  it("坏掉的结果文件被跳过，不影响其他文件", async () => {
    const kb = path.join(root, "kb-broken-results")
    const dir = path.join(resultsDir(kb), "recA")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "20261124T101500-aaaa.json"), "{ 坏 JSON", "utf8")
    await fs.writeFile(path.join(dir, "20261124T101500-bbbb.json"), JSON.stringify({ version: 1 }), "utf8")
    expect(await listRuns(kb, "recA")).toEqual([])
  })
})
