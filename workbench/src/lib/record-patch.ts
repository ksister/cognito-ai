/**
 * T31：`feishu_record_id` 只由服务端推送流程写回（T4 的写回路径），客户端 PUT 不能设置它。
 * 之前 PUT 会把请求体里的字段原样并进 patch，一个脚本/前端就能改掉行号，
 * 11-10 的 `.tmp/repair-feishu-ids.mjs` 正是走这条路写回绑定的。
 */
export type PatchWithFeishuId = { feishuRecordId?: unknown } & Record<string, unknown>

export function stripFeishuRecordId<T extends PatchWithFeishuId>(patch: T): Omit<T, "feishuRecordId"> {
  const next: Record<string, unknown> = { ...patch }
  delete next.feishuRecordId
  return next as Omit<T, "feishuRecordId">
}
