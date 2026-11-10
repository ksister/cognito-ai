import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { emptyDraft } from "./types"
import {
  OCR_TRANSCRIPT_MARKER,
  applyTranscript,
  cleanWindowTitle,
  dropTitleTurns,
  formatScreenshotChat,
  mergeTranscriptList,
  mergeTranscripts,
  normalizeSpeakerName,
  normalizeTranscriptText,
  parseTranscript,
  resolveExtractedChat,
  type TranscriptTurn,
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

describe("transcript cleanup (T18)", () => {
  it("writes emoji and stickers as [表情] and never saves 乱码", () => {
    expect(normalizeTranscriptText("好的🌞🐯🐯")).toBe("好的[表情][表情][表情]")
    expect(normalizeTranscriptText("👍🏽 🇨🇳 1️⃣ 👨‍👩‍👧‍👦")).toBe("[表情] [表情] [表情] [表情]")
    expect(normalizeTranscriptText("型号 A7□ 报错\uFFFD")).toBe("型号 A7 报错")

    const chat = formatScreenshotChat([
      { speaker: "客户", text: "好的🌞" },
      { speaker: "客户", text: "□□" },
    ])
    expect(chat).toBe([OCR_TRANSCRIPT_MARKER, "客户：好的[表情]"].join("\n"))
    expect(chat).not.toMatch(/[□\uFFFD]/)
  })

  it("cleans the clock/status prefix out of the window title", () => {
    expect(cleanWindowTitle("10:23 示例客户(12) 示例科技技术支持 …")).toBe("示例客户(12) 示例科技技术支持")
    expect(cleanWindowTitle("示例客户(12) 示例科技技术支持")).toBe("示例客户(12) 示例科技技术支持")
    expect(cleanWindowTitle("")).toBe("")
  })

  it("drops a title line that the model copied as a message", () => {
    const title = "示例客户(12) 示例科技技术支持"
    const turns: TranscriptTurn[] = [
      { speaker: "客户", text: title, kind: "speech" },
      { speaker: "客户", text: "定位偏了 0.3mm", kind: "speech" },
    ]
    expect(dropTitleTurns(turns, title).map((t) => t.text)).toEqual(["定位偏了 0.3mm"])
    expect(dropTitleTurns(turns, "其他标题")).toHaveLength(2)
  })

  it("tells the model not to emit □ and to use [表情]", () => {
    const example = parseFeishuTableSchema(
      JSON.parse(readFileSync(path.join(process.cwd(), "config", "feishu-table.example.json"), "utf8")),
    )
    const system = vlSystemFor(example)
    expect(system).toContain("[表情]")
    expect(system).toContain("乱码")
    expect(system).not.toContain("用 □")
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

describe("normalizeSpeakerName", () => {
  it("strips emoji", () => {
    expect(normalizeSpeakerName("Lucas🐻")).toBe("Lucas")
    expect(normalizeSpeakerName("Lucas🌹🌞💧")).toBe("Lucas")
  })
  it("strips the 天云_ / 天云 company prefix", () => {
    expect(normalizeSpeakerName("天云_殷杰")).toBe("殷杰")
    expect(normalizeSpeakerName("天云 殷杰")).toBe("殷杰")
  })
  it("leaves ordinary names alone", () => {
    expect(normalizeSpeakerName("Lucas")).toBe("Lucas")
    expect(normalizeSpeakerName("张工")).toBe("张工")
  })
})

describe("mergeTranscripts", () => {
  const a: TranscriptTurn[] = [
    { speaker: "Lucas", text: "问题A", kind: "speech" },
    { speaker: "Lucas", text: "问题B", kind: "speech" },
    { speaker: "Lucas", text: "问题C", kind: "speech" },
  ]
  const b: TranscriptTurn[] = [
    { speaker: "Lucas", text: "问题B", kind: "speech" },
    { speaker: "Lucas", text: "问题C", kind: "speech" },
    { speaker: "Lucas", text: "问题D", kind: "speech" },
  ]
  it("drops the overlapping tail/head", () => {
    expect(mergeTranscripts(a, b).map((t) => t.text)).toEqual(["问题A", "问题B", "问题C", "问题D"])
  })
  it("keeps everything when there is no overlap", () => {
    const c: TranscriptTurn[] = [{ speaker: "Lucas", text: "问题E", kind: "speech" }]
    expect(mergeTranscripts(a, c).map((t) => t.text)).toEqual(["问题A", "问题B", "问题C", "问题E"])
  })
  it("matches through emoji/company-prefix differences", () => {
    const c: TranscriptTurn[] = [
      { speaker: "Lucas🐻", text: "问题C", kind: "speech" },
      { speaker: "天云_殷杰", text: "问题D", kind: "speech" },
    ]
    expect(mergeTranscripts(a, c).map((t) => t.text)).toEqual(["问题A", "问题B", "问题C", "问题D"])
  })
  it("merges a list in order", () => {
    expect(mergeTranscriptList([a, b]).map((t) => t.text)).toEqual(["问题A", "问题B", "问题C", "问题D"])
  })
})
