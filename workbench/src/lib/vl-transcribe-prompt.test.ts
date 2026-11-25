import { describe, expect, it } from "vitest"
import { TRANSCRIPT_SIDE_RULE_V3, VL_TRANSCRIPT_RULE, VL_TRANSCRIPT_RULE_V2, VL_TRANSCRIPT_RULE_V3 } from "./transcript"
import { buildSnapshotTranscriptPrompt, buildTranscriptPromptV2, buildTranscriptPromptV3 } from "./vl-transcribe"

describe("转写提示词版本", () => {
  it("v1 保持原来的发言人规则（主流程用它，不要改）", () => {
    expect(VL_TRANSCRIPT_RULE).toContain("右侧 speaker 用调用方给出的本人昵称")
    expect(VL_TRANSCRIPT_RULE).toContain("左侧 speaker 用 contact")
  })

  it("v2 不再让模型自己写「我」/「客户」，只记气泡位置和截图昵称", () => {
    expect(VL_TRANSCRIPT_RULE_V2).toContain("绝对不要自己写「我」「客户」")
    expect(VL_TRANSCRIPT_RULE_V2).toContain("气泡在右侧填 right")
    expect(VL_TRANSCRIPT_RULE_V2).not.toContain("用调用方给出的本人昵称")
  })

  it("v3 就是在 v1 原文里插入侧别规则：把插入的那段删掉就完全等于 v1", () => {
    expect(VL_TRANSCRIPT_RULE_V3.replace(TRANSCRIPT_SIDE_RULE_V3, "")).toBe(VL_TRANSCRIPT_RULE)
    // 插在「按气泡位置判断」那句后面，而不是整段末尾
    const speakerAt = VL_TRANSCRIPT_RULE_V3.indexOf("截图不显示昵称时按气泡位置判断")
    const sideAt = VL_TRANSCRIPT_RULE_V3.indexOf(TRANSCRIPT_SIDE_RULE_V3)
    const formatAt = VL_TRANSCRIPT_RULE_V3.indexOf("时间分隔不要带 speaker")
    expect(speakerAt).toBeGreaterThan(-1)
    expect(sideAt).toBeGreaterThan(speakerAt)
    expect(sideAt).toBeLessThan(formatAt)
  })

  it("v3 的三条规则：头像在哪边、气泡颜色、连续消息归属", () => {
    expect(TRANSCRIPT_SIDE_RULE_V3).toContain("头像在哪一边")
    expect(TRANSCRIPT_SIDE_RULE_V3).toContain("不要按气泡离屏幕边缘的距离")
    expect(TRANSCRIPT_SIDE_RULE_V3).toContain("缩进不代表换人")
    expect(TRANSCRIPT_SIDE_RULE_V3).toContain("彩色气泡")
    expect(TRANSCRIPT_SIDE_RULE_V3).toContain("白色或灰色")
    expect(TRANSCRIPT_SIDE_RULE_V3).toContain("算上一个发送者的")
    expect(TRANSCRIPT_SIDE_RULE_V3).toContain("除非气泡颜色变了")
  })

  it("没有「一个彩色气泡都没有就全 left」这条（模型漏看彩色气泡会把我的消息全判成客户）", () => {
    expect(TRANSCRIPT_SIDE_RULE_V3).not.toContain("一个彩色气泡都没有")
    expect(TRANSCRIPT_SIDE_RULE_V3).not.toContain("全部填 left")
  })

  it("两版都保留逐字转写和格式要求", () => {
    for (const rule of [VL_TRANSCRIPT_RULE, VL_TRANSCRIPT_RULE_V3]) {
      expect(rule).toContain("不要摘要、不要改写")
      expect(rule).toContain("[表情]")
      expect(rule).toContain("时间分隔不要带 speaker")
    }
  })

  it("v3 提示词 = v1 提示词 + 侧别规则（v1 的其余内容不变）", () => {
    const v1 = buildSnapshotTranscriptPrompt()
    const v3 = buildTranscriptPromptV3()
    expect(v3.replace(TRANSCRIPT_SIDE_RULE_V3, "")).toBe(v1)
  })

  it("v1 提示词里没有 v3 的措辞（主流程不受影响）", () => {
    const v1 = buildSnapshotTranscriptPrompt()
    expect(v1).not.toContain("彩色气泡")
    expect(v1).not.toContain("头像在哪一边")
  })

  it("v2 提示词带上我的昵称清单（历史版本，仍可构建）", () => {
    expect(buildTranscriptPromptV2({ myNicknames: ["张三"] })).toContain("张三")
  })
})
