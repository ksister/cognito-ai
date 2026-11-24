/** 固定并发池（脚本和页面共用，失败由 worker 自己处理）。 */
export async function runPool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  const n = Math.max(1, Math.min(Number(limit) || 1, items.length || 1))
  let cursor = 0
  const runners = Array.from({ length: n }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      await worker(items[i], i)
    }
  })
  await Promise.all(runners)
}
