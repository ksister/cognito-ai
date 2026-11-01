import "server-only"
import { buildExtractSystem, constrainDraftSelects, FeishuSchemaError, normalizeExtractedDraft } from "./feishu-schema"
import { loadFeishuSchemaState } from "./feishu-schema-load"
import {
  localDate,
  type ExtractResult,
  type Need,
  type RecordDraft,
  type SupportRecord,
} from "./types"

const API_KEY = process.env.AI_API_KEY
const BASE_URL = (process.env.AI_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "")
const MODEL = process.env.AI_MODEL ?? "deepseek-chat"

export function aiConfigured() {
  return Boolean(API_KEY)
}

export function aiLabel() {
  return API_KEY ? `${MODEL}` : "未配置（规则提取）"
}

async function chatJson<T>(system: string, user: string): Promise<T> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`AI 接口返回 ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  const text: string = json.choices?.[0]?.message?.content ?? ""
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("AI 返回内容不是 JSON")
  return JSON.parse(match[0]) as T
}

export async function extractRecord(
  chat: string,
  opts: { customer?: string; me?: string; profile?: string },
): Promise<ExtractResult> {
  const schemaState = await loadFeishuSchemaState()
  if (!schemaState.ok) throw new FeishuSchemaError(schemaState.error)
  const schema = schemaState.schema
  if (!API_KEY) {
    return {
      mode: "rules",
      draft: constrainDraftSelects(rulesExtract(chat, opts.me), schema),
      warning: "未配置 AI_API_KEY，已用规则做初步提取，请重点核对问题描述和解决方案。",
      source: "paste",
    }
  }
  try {
    const user = [
      opts.profile ? `【我的背景】\n${opts.profile}` : "",
      opts.customer ? `【客户】${opts.customer}` : "",
      opts.me ? `【我在聊天中的昵称】${opts.me}（其余发言人默认是客户方）` : "",
      `【聊天记录】\n${chat.slice(0, 30000)}`,
    ]
      .filter(Boolean)
      .join("\n\n")
    const draft = await chatJson<Record<string, unknown>>(buildExtractSystem(schema, "paste"), user)
    return { mode: "ai", draft: normalizeExtractedDraft(draft, schema), source: "paste" }
  } catch (e) {
    if (e instanceof FeishuSchemaError) throw e
    return {
      mode: "rules",
      draft: constrainDraftSelects(rulesExtract(chat, opts.me), schema),
      warning: `AI 调用失败（${(e as Error).message}），已改用规则提取。`,
      source: "paste",
    }
  }
}

type Msg = { who: string; text: string; date?: string }

const HEADER_PATTERNS: RegExp[] = [
  /^(.{1,24}?)\s+(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)\s+\d{1,2}:\d{2}(:\d{2})?$/,
  /^(.{1,24}?)\s+(\d{1,2}月\d{1,2}日)\s+\d{1,2}:\d{2}$/,
  /^(.{1,24}?)\s+(?:昨天|今天|星期.|周.)?\s*\d{1,2}:\d{2}(:\d{2})?$/,
  /^(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+\d{1,2}:\d{2}(:\d{2})?\s+(.{1,24})$/,
]

function normDate(s?: string): string | undefined {
  if (!s) return undefined
  const full = s.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/)
  if (full) return `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}`
  const md = s.match(/(\d{1,2})月(\d{1,2})日/)
  if (md) return `${new Date().getFullYear()}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`
  return undefined
}

export function parseChat(chat: string): Msg[] {
  const lines = chat.replace(/\r/g, "").split("\n")
  const msgs: Msg[] = []
  let cur: Msg | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let header: { who: string; date?: string } | null = null
    for (const [i, re] of HEADER_PATTERNS.entries()) {
      const m = line.match(re)
      if (m) {
        header = i === 3 ? { who: m[3], date: normDate(m[1]) } : { who: m[1], date: normDate(m[2]) }
        break
      }
    }
    if (header) {
      cur = { who: header.who.trim(), text: "", date: header.date }
      msgs.push(cur)
      continue
    }
    const inline = line.match(/^(?:\[[^\]]+\]\s*)?([^:：\s]{1,16})\s*[:：]\s*(.+)$/)
    if (inline && !/^https?$/i.test(inline[1])) {
      cur = { who: inline[1], text: inline[2] }
      msgs.push(cur)
      continue
    }
    if (cur) cur.text += (cur.text ? "\n" : "") + line
    else {
      cur = { who: "未知", text: line }
      msgs.push(cur)
    }
  }
  return msgs.filter((m) => m.text)
}

const CATEGORY_RULES: [string, RegExp][] = [
  ["软件Bug", /崩溃|闪退|报错|异常|bug|卡死|无响应|错误码/i],
  ["安装/授权", /安装|授权|license|加密狗|激活|注册码|驱动/i],
  ["相机/硬件", /相机|镜头|光源|曝光|触发|采集|工控机|显卡|网口/],
  ["通讯/PLC", /PLC|plc|通讯|通信|TCP|Modbus|串口|IO|信号/],
  ["算法效果", /识别|误检|漏检|精度|定位|偏移|标定|匹配|找不到|检测不到|OCR|读码/i],
  ["需求建议", /能不能|能否|希望|建议|要是能|有没有办法/],
]

const NEED_RE = /能不能|能否|希望|建议|要是能|有没有办法|太麻烦|不方便|每次都要|好麻烦|手动/

export function rulesExtract(chat: string, me?: string): Partial<RecordDraft> {
  const msgs = parseChat(chat)
  const speakers = [...new Set(msgs.map((m) => m.who))]
  const myName = me?.trim() || (speakers.length > 1 ? speakers[1] : "")
  const isMe = (m: Msg) => Boolean(myName) && m.who === myName
  const theirs = msgs.filter((m) => !isMe(m))
  const mine = msgs.filter(isMe)
  const all = msgs.map((m) => m.text).join("\n")

  const firstQuestion = theirs.slice(0, 3).map((m) => m.text).join("\n")
  const category = CATEGORY_RULES.find(([, re]) => re.test(firstQuestion || all))?.[0] ?? "使用咨询"

  const needs: Need[] = theirs
    .filter((m) => NEED_RE.test(m.text))
    .slice(0, 5)
    .map((m) => ({ pain: m.text.slice(0, 120), idea: "", type: "软件改进" as const }))

  const contact = theirs[0]?.who && theirs[0].who !== "未知" ? theirs[0].who : ""
  const date = msgs.find((m) => m.date)?.date ?? localDate()
  const title = (theirs[0]?.text ?? msgs[0]?.text ?? "").split("\n")[0].slice(0, 24)

  return {
    title,
    date,
    contact,
    category,
    status: /解决了|好了|可以了|搞定|正常了|没问题了/.test(all.slice(-400)) ? "已解决" : "跟进中",
    problem: firstQuestion,
    process: mine
      .slice(0, 8)
      .map((m, i) => `${i + 1}. ${m.text.split("\n")[0].slice(0, 100)}`)
      .join("\n"),
    solution: mine.length ? mine[mine.length - 1].text : "",
    needs,
    uncertain: [
      "规则提取：问题描述取自客户前几条消息，解决方案取自我的最后一条消息，请核对。",
      myName
        ? `已将「${myName}」识别为我方，其余为客户方。`
        : "未能识别我方昵称，请在左侧填写「我在聊天里的昵称」后重新整理。",
    ],
  }
}

const ANALYZE_SYSTEM = `你是一名机器视觉软件的产品需求分析师，帮助 AE 工程师把一线技术支持中积累的痛点整理成可以提交给研发的需求。

输入是一组"需求线索"，每条包含客户、日期、模块、问题分类、痛点和初步想法。

请输出 JSON：{"title": "本次需求分析标题", "markdown": "完整的 Markdown 文档"}

Markdown 文档结构：
# 标题
## 概览（线索总数、涉及客户数、高频模块）
## 需求清单
按主题聚类，每个需求包含：
### 需求名称
- **痛点**：用户真实遇到的问题（合并同类）
- **涉及客户/次数**：列出客户名和次数
- **建议方案**：软件改进或辅助工具的具体形态
- **价值**：节省多少支持工作、影响多少客户
- **优先级**：P0/P1/P2，附理由
- **来源记录**：列出对应的日期+客户
## 可以先做的辅助工具（AE 自己或小成本就能实现的）
## 需要补充调研的问题

只基于输入内容，不编造客户和数据。`

export type NeedRow = Need & { customer: string; date: string; module: string; category: string; title: string }

export function collectNeeds(records: SupportRecord[]): NeedRow[] {
  return records.flatMap((r) =>
    r.needs.map((n) => ({
      ...n,
      customer: r.customer,
      date: r.date,
      module: r.module,
      category: r.category,
      title: r.title,
    })),
  )
}

export async function analyzeNeeds(rows: NeedRow[]): Promise<{ title: string; markdown: string; mode: "ai" | "rules"; warning?: string }> {
  if (API_KEY) {
    try {
      const input = rows
        .map(
          (r, i) =>
            `${i + 1}. [${r.date}][${r.customer}][${r.module || "未知模块"}][${r.category}] 痛点：${r.pain}；想法：${r.idea || "无"}；类型：${r.type}`,
        )
        .join("\n")
      const res = await chatJson<{ title: string; markdown: string }>(ANALYZE_SYSTEM, input)
      return { ...res, mode: "ai" }
    } catch (e) {
      return { ...rulesAnalyze(rows), mode: "rules", warning: `AI 调用失败（${(e as Error).message}），已生成规则版草稿。` }
    }
  }
  return { ...rulesAnalyze(rows), mode: "rules", warning: "未配置 AI_API_KEY，已按模块分组生成草稿。" }
}

function rulesAnalyze(rows: NeedRow[]) {
  const groups = new Map<string, NeedRow[]>()
  for (const r of rows) {
    const key = r.module || "未标注模块"
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
  const customers = new Set(rows.map((r) => r.customer))
  const title = `需求线索汇总 ${localDate()}`
  const lines = [
    `# ${title}`,
    "",
    "## 概览",
    `- 线索总数：${rows.length}`,
    `- 涉及客户：${customers.size}（${[...customers].join("、")}）`,
    `- 高频模块：${sorted.slice(0, 3).map(([k, v]) => `${k}(${v.length})`).join("、")}`,
    "",
    "## 需求清单（按模块分组，待人工聚类）",
  ]
  for (const [mod, items] of sorted) {
    const cs = new Set(items.map((i) => i.customer))
    lines.push("", `### ${mod}`, `- **涉及客户/次数**：${[...cs].join("、")} / ${items.length} 次`, "- **痛点与想法**：")
    for (const i of items) lines.push(`  - ${i.pain}${i.idea ? ` → ${i.idea}` : ""}（${i.date} ${i.customer}，${i.type}）`)
    lines.push("- **建议方案**：", "- **优先级**：")
  }
  lines.push("", "## 需要补充调研的问题", "- ")
  return { title, markdown: lines.join("\n") }
}
