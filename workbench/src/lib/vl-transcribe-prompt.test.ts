import { describe, expect, it } from "vitest"
import { VL_TRANSCRIPT_RULE, VL_TRANSCRIPT_RULE_V2 } from "./transcript"
import { buildSnapshotTranscriptPrompt, buildTranscriptPromptV2 } from "./vl-transcribe"

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

  it("两版都保留逐字转写和格式要求", () => {
    for (const rule of [VL_TRANSCRIPT_RULE, VL_TRANSCRIPT_RULE_V2]) {
      expect(rule).toContain("不要摘要、不要改写")
      expect(rule).toContain("[表情]")
      expect(rule).toContain("时间分隔不要带 speaker")
    }
  })

  it("v2 提示词带上我的昵称清单", () => {
    const prompt = buildTranscriptPromptV2({ myNicknames: ["张三", "小张"] })
    expect(prompt).toContain("张三")
    expect(prompt).toContain("小张")
    expect(prompt).toContain("side")
  })

  it("没填昵称时 v2 提示词不硬塞空清单", () => {
    const prompt = buildTranscriptPromptV2({ myNicknames: [] })
    expect(prompt).not.toContain("用户在聊天里的昵称可能是：")
    expect(prompt).toContain("气泡在右侧填 right")
  })

  it("v1 提示词没被改动（不含 v2 的措辞）", () => {
    const prompt = buildSnapshotTranscriptPrompt()
    expect(prompt).not.toContain("绝对不要自己写「我」")
    expect(prompt).toContain("side")
  })
})
