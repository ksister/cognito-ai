import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const kb = mkdtempSync(path.join(os.tmpdir(), "feishu-t9-"))
process.env.KB_DIR = kb

const { createRecord, getRecord, updateRecord } = await import("./kb")

describe("old records without config-driven keys", () => {
  beforeAll(() => {
    const dir = path.join(kb, "customers", "示例客户", "records")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, "2026-10-15-旧记录.md"),
      `---
title: 旧记录
date: '2026-10-15'
customer: 示例客户
channel: 微信
contact: 王工
product: 视觉软件
module: 读码
category: 算法效果
status: 跟进中
feishu_synced: false
needs: []
created: '2026-10-15T00:00:00.000Z'
updated: '2026-10-15T00:00:00.000Z'
---
# 旧记录

## 问题描述
还能打开

## 处理过程

## 解决方案

## 我的思考
不要改这里

## 待确认

## 原始聊天记录
\`\`\`\`text
原文
\`\`\`\`
`,
      "utf8",
    )
  })

  afterAll(() => {
    rmSync(kb, { recursive: true, force: true })
  })

  it("opens a record that has none of the new keys", async () => {
    const rec = await getRecord("示例客户", "2026-10-15-旧记录")
    expect(rec).not.toBeNull()
    expect(rec?.title).toBe("旧记录")
    expect(rec?.problem).toBe("还能打开")
    expect(rec?.thoughts).toBe("不要改这里")
    expect(rec?.channel).toBe("微信")
    expect(rec?.status).toBe("AE处理中")
    expect(rec?.site).toBe("")
    expect(rec?.support_type).toBe("")
    expect(rec?.resolution).toBe("")
    expect(rec?.dimensions).toEqual([])
    expect(rec?.case_visibility).toBe("")
    expect(rec?.local_id).toBe("")
    expect(rec?.feishuRecordId).toBe("")
    expect(rec?.feishuSyncedAt).toBe("")
    expect(rec?.feishuAttached).toEqual([])
    expect(rec?.extras).toEqual({})
  })

  it("round-trips an English key without dropping older fields", async () => {
    const created = await createRecord({
      title: "新字段",
      date: "2026-10-16",
      customer: "示例客户",
      channel: "不是旧枚举",
      contact: "李工",
      product: "",
      module: "",
      category: "算法效果",
      status: "已关闭",
      problem: "问题",
      process: "",
      solution: "",
      thoughts: "思考原文",
      needs: [],
      uncertain: [],
      chat: "",
      screenshots: [],
      site: "示例一号线",
      support_type: "bug确认",
      resolution: "",
      fixed_version: "",
      dimensions: ["2D"],
      inspection_types: [],
      industries: [],
      case_visibility: "",
      docs: "",
      local_id: "",
      extras: {},
    })
    const again = await getRecord("示例客户", created.file.replace(/\.md$/, ""))
    expect(again?.support_type).toBe("bug确认")
    expect(again?.site).toBe("示例一号线")
    expect(again?.dimensions).toEqual(["2D"])
    expect(again?.status).toBe("已解决")
    expect(again?.local_id).toMatch(/^AE-20261016-\d{2}$/)
    expect(again?.channel).toBe("不是旧枚举")
    expect(again?.category).toBe("算法效果")
    expect(again?.thoughts).toBe("思考原文")
    expect(again?.problem).toBe("问题")
    expect(again?.feishuRecordId).toBe("")
  })

  it("keeps feishu_record_id when the record is edited again", async () => {
    const created = await createRecord({
      title: "同一行",
      date: "2026-10-30",
      customer: "示例客户",
      channel: "微信",
      contact: "",
      product: "",
      module: "",
      category: "",
      status: "待处理",
      problem: "先建行",
      process: "",
      solution: "",
      thoughts: "思考留着",
      needs: [],
      uncertain: [],
      chat: "",
      screenshots: ["2026-10-30-同一行-1.jpg"],
      site: "",
      support_type: "",
      resolution: "",
      fixed_version: "",
      dimensions: [],
      inspection_types: [],
      industries: [],
      case_visibility: "",
      docs: "",
      local_id: "",
      extras: {},
    })
    const slug = created.file.replace(/\.md$/, "")
    const marked = await updateRecord(created.customer, slug, {
      feishuRecordId: "rec_example_same",
      feishuSynced: true,
      feishuSyncedAt: "2026-10-30T02:00:00.000Z",
      feishuAttached: ["2026-10-30-同一行-1.jpg"],
    })
    expect(marked.feishuRecordId).toBe("rec_example_same")
    expect(marked.feishuSynced).toBe(true)
    expect(marked.thoughts).toBe("思考留着")

    const edited = await updateRecord(created.customer, slug, { status: "已解决" })
    expect(edited.feishuRecordId).toBe("rec_example_same")
    expect(edited.feishuSynced).toBe(true)
    expect(edited.feishuAttached).toEqual(["2026-10-30-同一行-1.jpg"])
    expect(edited.status).toBe("已解决")
    expect(edited.thoughts).toBe("思考留着")

    const again = await getRecord("示例客户", slug)
    expect(again?.feishuRecordId).toBe("rec_example_same")
    expect(again?.feishuSyncedAt).toContain("2026-10-30")
  })
})
