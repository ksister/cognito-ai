/**
 * T31：飞书同步状态类字段只由服务端推送流程写回（T4 的写回路径 / mark-synced），
 * 客户端 PUT 不能设置它们。
 *
 * 背景：PUT 原来会把请求体原样并进 patch，一个脚本就能改掉 `feishu_record_id`；
 * 11-10 的 `.tmp/repair-feishu-ids.mjs` 正是走这条路写回绑定的。
 * 前端没有正常流程会传这四个字段（grep 见 PR 描述），所以一律挡掉。
 */

export const SERVER_MANAGED_KEYS = [
  "feishuRecordId",
  "feishuSynced",
  "feishuSyncedAt",
  "feishuAttached",
] as const

export type ServerManagedKey = (typeof SERVER_MANAGED_KEYS)[number]

export type PatchWithServerFields = Partial<Record<ServerManagedKey, unknown>> & Record<string, unknown>

export function stripServerManagedFields<T extends PatchWithServerFields>(patch: T): Omit<T, ServerManagedKey> {
  const next: Record<string, unknown> = { ...patch }
  for (const key of SERVER_MANAGED_KEYS) delete next[key]
  return next as Omit<T, ServerManagedKey>
}
