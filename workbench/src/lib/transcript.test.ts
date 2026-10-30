import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { emptyDraft } from "./types"
import {
  OCR_TRANSCRIPT_MARKER,
  applyTranscript,
  formatScreenshotChat,
  parseTranscript,
  resolveExtractedChat,
} from "./transcript"
import { EXTRACT_VL_SYSTEM, normalizeVlDraft } from "./vl"

const FIXTURE = {
  title: "极耳定位偏移",
  date: "2026-10-28",
  contact: "张工",
  channel: "微信",
  product: "视觉软件 V4.3",
  module: "定位",
  category: "算法效果",
  status: "已解决",
  problem: "换料后极耳定位偏约 0.3mm",
  process: "1. 看图",
  solution: "曝光 3000 调到 4500",
  needs: [],
  uncertain: ["是否所有相机都偏"],
  transcript: [
    { speaker: "张工", text: "极耳定位偏了约 0.3mm，匹配分数 0.62" },
    { speaker: "小李", text: "曝光从 3000 调到 4500" },
    { speaker: "", text: "看不清的一句" },
  ],
}

const EXPECTED_CHAT = [
  OCR_TRANSCRIPT_MARKER,
  "张工：极耳定位偏了约 0.3mm，匹配分数 0.62",
  "小李：曝光从 3000 调到 4500",
  "未知：看不清的一句",
].join("\n")

describe("VL transcript", () => {
  it("puts transcript in the prompt and parses it into 原始聊天记录", () => {
    expect(EXTRACT_VL_SYSTEM).toContain('"transcript"')
    expect(EXTRACT_VL_SYSTEM).toContain("逐字转写")
    expect(EXTRACT_VL_SYSTEM).toContain("不要自己添加")
    expect(EXTRACT_VL_SYSTEM).not.toContain("请输出首行 [OCR")

    const draft = normalizeVlDraft(FIXTURE)
    expect(draft.chat).toBe(EXPECTED_CHAT)
    expect(draft.problem).toBe(FIXTURE.problem)
    expect(draft.uncertain).toEqual(["是否所有相机都偏", "有发言未能识别发言人，已标为「未知」"])
    expect(draft.title).toBe("极耳定位偏移")
  })

  it("accepts 发言人/内容 objects and plain lines", () => {
    expect(
      parseTranscript([
        { 发言人: "王工", 内容: "读码率 92%，要求 99.5%" },
        "小李：型号是 V4.3",
      ]),
    ).toEqual([
      { speaker: "王工", text: "读码率 92%，要求 99.5%" },
      { speaker: "小李", text: "型号是 V4.3" },
    ])

    const chat = formatScreenshotChat(parseTranscript("张工：比值 1:2\n[OCR 转写，以截图为准]\n"))
    expect(chat).toBe(`${OCR_TRANSCRIPT_MARKER}\n张工：比值 1:2`)
  })

  it("does not invent lines when transcript is missing", () => {
    const applied = applyTranscript(null, [])
    expect(applied.chat).toBe(OCR_TRANSCRIPT_MARKER)
    expect(applied.uncertain).toEqual(["截图转写为空，请对照截图补全原始聊天记录"])
  })

  it("keeps pasted chat and replaces chat for screenshots", () => {
    const pasted = "张工 09:12\n极耳又偏了"
    expect(resolveExtractedChat("paste", pasted, EXPECTED_CHAT)).toBe(pasted)
    expect(resolveExtractedChat("paste", pasted, undefined)).toBe(pasted)
    expect(resolveExtractedChat("screenshot", pasted, EXPECTED_CHAT)).toBe(EXPECTED_CHAT)
    expect(resolveExtractedChat(undefined, pasted, EXPECTED_CHAT)).toBe(pasted)
  })
})

describe("saved markdown", () => {
  let tmp = ""

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  it("writes the full screenshot transcript into 原始聊天记录 and leaves paste as-is", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "t2-kb-"))
    process.env.KB_DIR = tmp
    const kb = await import("./kb")

    const shot = await kb.createRecord({
      ...emptyDraft("T2Fixture"),
      title: "转写保存",
      problem: "定位偏移",
      chat: EXPECTED_CHAT,
    })
    const shotPath = path.join(tmp, "customers", "T2Fixture", "records", shot.file)
    const shotMd = await readFile(shotPath, "utf8")
    expect(shotMd).toContain("## 原始聊天记录")
    expect(shotMd).toContain(EXPECTED_CHAT)
    const loaded = await kb.getRecord("T2Fixture", shot.file.replace(/\.md$/, ""))
    expect(loaded?.chat).toBe(EXPECTED_CHAT)

    const pasted = "张工 09:12\n极耳又偏了，没有转写标记"
    const pasteRec = await kb.createRecord({
      ...emptyDraft("T2Fixture"),
      title: "粘贴原文",
      problem: "仍是原文",
      chat: pasted,
    })
    const pasteMd = await readFile(path.join(tmp, "customers", "T2Fixture", "records", pasteRec.file), "utf8")
    expect(pasteMd).toContain(pasted)
    expect(pasteMd).not.toContain(OCR_TRANSCRIPT_MARKER)
    const pasteLoaded = kb.markdownToRecord("T2Fixture", pasteRec.file, pasteMd)
    expect(pasteLoaded.chat).toBe(pasted)
  })
})
