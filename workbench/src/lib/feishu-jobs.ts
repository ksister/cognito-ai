import type { LarkPushResult } from "./lark-bitable"

/** Save-and-return (D19): the local record is written first, the Feishu push runs in background. */
export type FeishuJobStatus = "writing" | "written" | "failed"

type Job = { status: FeishuJobStatus; result?: LarkPushResult; at: number }

const jobs = new Map<string, Job>()

export function recordKey(customer: string, file: string): string {
  return `${customer}/${file}`
}

export function setFeishuJob(key: string, status: FeishuJobStatus, result?: LarkPushResult): void {
  jobs.set(key, { status, result, at: Date.now() })
}

export function getFeishuJob(key: string): Job | undefined {
  return jobs.get(key)
}

/** Number of Feishu writes still in flight (used by the desktop "wait before exit" logic). */
export function pendingFeishuJobs(): number {
  let n = 0
  for (const job of jobs.values()) if (job.status === "writing") n++
  return n
}
