import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import {
  deriveRunState,
  isSafeRecordId,
  isValidRunId,
  normalizeReviewFields,
  parseReplayRun,
  sortRunsNewestFirst,
  type ReplayFieldReview,
  type ReplayRun,
  type ReplayRunState,
} from "./replay-result.ts"
import { resultsDir, writeJsonAtomic } from "./replay-store.ts"

/**
 * T27 结果目录（D21）：KB_DIR/replay/results/<飞书记录 ID>/<runId>.json
 *
 * - 一个文件 = 一次运行；每次都记模式、模型、提示词版本、时间、用量、费用。
 * - 用户的建议和问题类型存在同一个文件的 `review` 里；点「完成核对」才写 reviewedAt。
 * - 这里只读写 KB_DIR 下的派生数据：不碰 customers/、不碰飞书。
 *
 * Script-safe: no `server-only`, `.ts` suffix on relative runtime imports.
 */

export function recordResultsDir(kbDir: string, recordId: string): string {
  if (!isSafeRecordId(recordId)) throw new Error("飞书记录 ID 不合法，拒绝拼路径")
  return path.join(resultsDir(kbDir), recordId)
}

export function runFilePath(kbDir: string, recordId: string, runId: string): string {
  if (!isValidRunId(runId)) throw new Error("运行 ID 不合法，拒绝拼路径")
  return path.join(recordResultsDir(kbDir, recordId), `${runId}.json`)
}

export async function writeRun(kbDir: string, run: ReplayRun): Promise<void> {
  const file = runFilePath(kbDir, run.recordId, run.runId)
  await writeJsonAtomic(file, run)
}

export async function readRun(kbDir: string, recordId: string, runId: string): Promise<ReplayRun | null> {
  try {
    const text = await fsp.readFile(runFilePath(kbDir, recordId, runId), "utf8")
    return parseReplayRun(JSON.parse(text))
  } catch {
    return null
  }
}

/** 一条记录的全部运行，新的在前；坏文件跳过（不让整页挂掉）。 */
export async function listRuns(kbDir: string, recordId: string): Promise<ReplayRun[]> {
  const dir = recordResultsDir(kbDir, recordId)
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch {
    return []
  }
  const runs: ReplayRun[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const run = await readRun(kbDir, recordId, name.slice(0, -".json".length))
    if (run) runs.push(run)
  }
  return sortRunsNewestFirst(runs)
}

/** 列出 results/ 下有结果的记录 ID（只看目录名，不读内容）。 */
export async function listRecordIdsWithResults(kbDir: string): Promise<string[]> {
  try {
    const dirs = await fsp.readdir(resultsDir(kbDir), { withFileTypes: true })
    return dirs.filter((d) => d.isDirectory() && isSafeRecordId(d.name)).map((d) => d.name)
  } catch {
    return []
  }
}

/** 每条记录的状态（列表页一次读入）。 */
export async function readRunStates(kbDir: string): Promise<Map<string, ReplayRunState>> {
  const out = new Map<string, ReplayRunState>()
  for (const recordId of await listRecordIdsWithResults(kbDir)) {
    out.set(recordId, deriveRunState(await listRuns(kbDir, recordId)))
  }
  return out
}

/**
 * 保存建议 / 问题类型（同一个文件的 review）。
 * `reviewed: true` 表示用户点了「完成核对」，写 reviewedAt；否则只更新草稿（保留原来的 reviewedAt）。
 */
export async function saveRunReview({
  kbDir,
  recordId,
  runId,
  fields,
  reviewed,
  speakerError,
  speakerErrorCount,
  textError,
  textErrorCount,
  textErrorNote,
  at = new Date(),
}: {
  kbDir: string
  recordId: string
  runId: string
  fields: unknown
  reviewed: boolean
  /** 记录级：发言人有误（可选，不传就保持原来的值）。 */
  speakerError?: boolean
  /** 记录级：发言人错了几条（可选）。 */
  speakerErrorCount?: number
  /** 记录级：文字有误（可选）。 */
  textError?: boolean
  /** 记录级：文字错了几处（可选）。 */
  textErrorCount?: number
  /** 记录级：文字错误的备注（可选，不传就保留原来的）。 */
  textErrorNote?: string
  at?: Date
}): Promise<{ ok: true; run: ReplayRun } | { ok: false; error: string }> {
  // 接口层已经挡过一次，这里再挡一次：这层是拼路径的最后一关。
  if (!isSafeRecordId(recordId)) return { ok: false, error: "记录 ID 格式不对（只允许字母、数字和 _-）" }
  if (!isValidRunId(runId)) return { ok: false, error: "运行 ID 格式不对" }
  const run = await readRun(kbDir, recordId, runId)
  if (!run) return { ok: false, error: "找不到这次运行的结果文件，可能已被清理，请重新识别一次" }
  const now = at.toISOString()
  const nextFields: Record<string, ReplayFieldReview> = normalizeReviewFields(fields)
  const nextSpeakerError = speakerError === undefined ? Boolean(run.review?.speakerError) : speakerError
  const rawCount = speakerErrorCount === undefined ? (run.review?.speakerErrorCount ?? 0) : speakerErrorCount
  const count = Number.isFinite(rawCount) ? Math.max(0, Math.min(9999, Math.round(rawCount))) : 0
  const nextTextError = textError === undefined ? Boolean(run.review?.textError) : textError
  const rawTextCount = textErrorCount === undefined ? (run.review?.textErrorCount ?? 0) : textErrorCount
  const textCount = Number.isFinite(rawTextCount) ? Math.max(0, Math.min(9999, Math.round(rawTextCount))) : 0
  const note = textErrorNote === undefined ? (run.review?.textErrorNote ?? "") : String(textErrorNote).trim().slice(0, 2000)
  run.review = {
    fields: nextFields,
    ...(nextSpeakerError ? { speakerError: true } : {}),
    ...(count > 0 ? { speakerErrorCount: count } : {}),
    ...(nextTextError ? { textError: true } : {}),
    ...(textCount > 0 ? { textErrorCount: textCount } : {}),
    ...(note ? { textErrorNote: note } : {}),
    reviewedAt: reviewed ? now : (run.review?.reviewedAt ?? null),
    updatedAt: now,
  }
  await writeRun(kbDir, run)
  return { ok: true, run }
}

/** 结果目录存在且里面有文件（页面判断「有没有结果」用）。 */
export function hasResults(kbDir: string, recordId: string): boolean {
  try {
    return fs.readdirSync(recordResultsDir(kbDir, recordId)).some((n) => n.endsWith(".json"))
  } catch {
    return false
  }
}
