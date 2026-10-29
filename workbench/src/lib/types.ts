export const CHANNELS = ["微信", "飞书", "电话", "现场", "邮件", "其他"] as const
export const STATUSES = ["待处理", "跟进中", "已解决", "已关闭"] as const
export const CATEGORIES = [
  "使用咨询",
  "软件Bug",
  "算法效果",
  "相机/硬件",
  "通讯/PLC",
  "安装/授权",
  "需求建议",
  "其他",
] as const
export const NEED_TYPES = ["软件改进", "辅助工具", "文档/教程", "其他"] as const
export const CUSTOMER_STAGES = ["售前", "POC/打样", "交付中", "量产维护", "已流失"] as const

export type Channel = (typeof CHANNELS)[number]
export type Status = (typeof STATUSES)[number]
export type NeedType = (typeof NEED_TYPES)[number]

export type Need = {
  pain: string
  idea: string
  type: NeedType
}

export type RecordDraft = {
  title: string
  date: string
  customer: string
  channel: Channel
  contact: string
  product: string
  module: string
  category: string
  status: Status
  problem: string
  process: string
  solution: string
  thoughts: string
  needs: Need[]
  uncertain: string[]
  chat: string
}

export type SupportRecord = RecordDraft & {
  id: string
  file: string
  feishuSynced: boolean
  created: string
  updated: string
}

export type CustomerProfile = {
  name: string
  stage: string
  industry: string
  products: string
  hardware: string
  contacts: string
  notes: string
}

export type CustomerSummary = CustomerProfile & {
  recordCount: number
  openCount: number
  firstDate: string | null
  lastDate: string | null
  needCount: number
}

export type ExtractResult = {
  mode: "ai" | "rules"
  draft: Partial<RecordDraft>
  warning?: string
}

export const OPEN_STATUSES: Status[] = ["待处理", "跟进中"]

export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function emptyDraft(customer = ""): RecordDraft {
  return {
    title: "",
    date: localDate(),
    customer,
    channel: "微信",
    contact: "",
    product: "",
    module: "",
    category: "使用咨询",
    status: "已解决",
    problem: "",
    process: "",
    solution: "",
    thoughts: "",
    needs: [],
    uncertain: [],
    chat: "",
  }
}
