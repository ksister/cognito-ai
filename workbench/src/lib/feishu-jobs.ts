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

/**
 * One write queue per record (T11 review 1).
 *
 * Two pushes for the same record must never race: without the lock, a save whose
 * background write is still running has no `feishu_record_id` yet, so a second save
 * creates a SECOND Feishu row. The queue makes the second task wait for the first to
 * finish (including writing the id back to disk); it then re-reads the record and
 * updates that same row. The edit page's "同步飞书" goes through this same lock.
 */
const chains = new Map<string, Promise<void>>()

export function enqueueFeishuWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  // Run whether or not the previous write succeeded: one failure must not block later saves.
  const run = prev.then(task, task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  chains.set(key, tail)
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}

/** Number of records with a queued or running Feishu write. */
export function pendingFeishuChains(): number {
  return chains.size
}
