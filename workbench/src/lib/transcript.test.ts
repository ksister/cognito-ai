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
import { parseFeishuTableSchema } from "./feishu-schema"
import {
  QWEN3_VL_PLUS_MAX_OUTPUT_TOKENS,
  TRUNCATED_VL_MESSAGE,
  errorIfTruncated,
  normalizeVlDraft,
  resolveVlMaxTokens,
  resolveVlTimeoutMs,
  VL_TIMEOUT_MS_DEFAULT,
  vlTimeoutMessage,
  vlTransportError,
  vlSystemFor,
} from "./vl"
import { readFileSync } from "node:fs"

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
    const example = parseFeishuTableSchema(
      JSON.parse(readFileSync(path.join(process.cwd(), "config", "feishu-table.example.json"), "utf8")),
    )
    const system = vlSystemFor(example)
    expect(system).toContain('"transcript"')
    expect(system).toContain("逐字转写")
    expect(system).toContain("不要自己添加")
    expect(system).not.toContain("请输出首行 [OCR")
    expect(system.lastIndexOf('"transcript"')).toBeGreaterThan(system.lastIndexOf('"uncertain"'))

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
      { speaker: "王工", text: "读码率 92%，要求 99.5%", kind: "speech" },
      { speaker: "小李", text: "型号是 V4.3", kind: "speech" },
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

  it("returns truncated when the VL finish_reason is length", () => {
    expect(QWEN3_VL_PLUS_MAX_OUTPUT_TOKENS).toBe(32768)
    expect(resolveVlMaxTokens("")).toBe(32768)
    expect(resolveVlMaxTokens("nope")).toBe(32768)
    expect(resolveVlMaxTokens("8192")).toBe(8192)
    const err = errorIfTruncated("length")
    expect(err?.code).toBe("truncated")
    expect(err?.message).toBe(TRUNCATED_VL_MESSAGE)
    expect(errorIfTruncated("stop")).toBeNull()
    expect(errorIfTruncated(undefined)).toBeNull()
  })

  it("keeps time separators as standalone lines", () => {
    const time = "—— 10月28日 09:12 ——"
    const chat = formatScreenshotChat(
      parseTranscript([
        { kind: "time", text: time },
        { speaker: "张工", text: "偏了 0.3mm" },
        "—— 10月28日 09:40 ——",
      ]),
    )
    expect(chat).toBe(
      [OCR_TRANSCRIPT_MARKER, time, "张工：偏了 0.3mm", "—— 10月28日 09:40 ——"].join("\n"),
    )
    expect(chat).not.toContain("未知：")
    expect(applyTranscript([{ kind: "time", text: "10月28日 09:12" }], []).uncertain).toEqual([])
  })

  it("formats image, file, and voice lines with a speaker", () => {
    const chat = formatScreenshotChat(
      parseTranscript([
        { speaker: "张工", text: "[图片]" },
        { speaker: "张工", text: "[文件] 参数表.xlsx" },
        { speaker: "小李", text: "[语音]" },
      ]),
    )
    expect(chat).toBe(
      [OCR_TRANSCRIPT_MARKER, "张工：[图片]", "张工：[文件] 参数表.xlsx", "小李：[语音]"].join("\n"),
    )
  })

  it("infers a speaker from bubble side when the nickname is missing", () => {
    const named = formatScreenshotChat(
      parseTranscript(
        [
          { side: "right", text: "我先看下日志" },
          { side: "left", text: "读码率只有 92%" },
        ],
        { me: "小李", contact: "王工" },
      ),
    )
    expect(named).toBe([OCR_TRANSCRIPT_MARKER, "小李：我先看下日志", "王工：读码率只有 92%"].join("\n"))

    const fallback = formatScreenshotChat(
      parseTranscript([
        { side: "right", text: "在" },
        { side: "左", text: "好" },
      ]),
    )
    expect(fallback).toBe([OCR_TRANSCRIPT_MARKER, "我：在", "客户：好"].join("\n"))
    expect(applyTranscript([{ side: "left", text: "好" }], []).uncertain).toEqual([])
  })
})

describe("VL timeout", () => {
  it("defaults to 5 minutes and tells the user to paste", () => {
    expect(VL_TIMEOUT_MS_DEFAULT).toBe(300_000)
    expect(resolveVlTimeoutMs("")).toBe(300_000)
    expect(resolveVlTimeoutMs("0")).toBe(300_000)
    expect(resolveVlTimeoutMs("nope")).toBe(300_000)
    expect(resolveVlTimeoutMs("90000")).toBe(90_000)
    expect(vlTimeoutMessage(300_000)).toBe("通义 VL 请求超时（已等待 5 分钟），请改用粘贴文字。截图较多时可分两批上传。")
    const err = vlTransportError(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), 300_000)
    expect(err.code).toBe("timeout")
    expect(err.message).toContain("请改用粘贴文字")
    expect(err.message).toContain("截图较多时可分两批上传")
    expect(err.message).toContain("5 分钟")
    const network = vlTransportError(new Error("connect ECONNREFUSED"))
    expect(network.code).toBe("parse_error")
    expect(network.message).toContain("可改用粘贴文字")
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
