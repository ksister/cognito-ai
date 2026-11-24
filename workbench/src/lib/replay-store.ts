import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { deriveReplayStatus, type ReplayManifest, type ReplayRecordDetail, type ReplayStatus } from "./replay-model.ts"

/**
 * T26 回放快照的磁盘布局（全部在 KB_DIR 下，不进仓库）：
 *
 *   KB_DIR/replay/snapshot/manifest.json          列表用（页面只读这个 + records/）
 *   KB_DIR/replay/snapshot/records/<R编号>.json    单条明细（飞书原字段 + 截图引用）
 *   KB_DIR/replay/snapshot/media/<hash>.<ext>     截图原件（按内容哈希命名、去重）
 *   KB_DIR/replay/snapshot/transcripts/<hash>.json 逐图转写（按截图哈希命名、去重）
 *   KB_DIR/replay/snapshot/_incoming/<recordId>/  新记录的下载暂存（不删，留作追溯）
 *   KB_DIR/replay/results/<recordId>/*.json       T27 的重新识别结果（T26 只读取状态）
 *
 * 快照必须自成一体：T32 清理 _t25-work/ 之后，页面和 T27 都只读 snapshot/。
 *
 * Script-safe: no `server-only`, `.ts` suffix on relative runtime imports.
 */

export function replayRoot(kbDir: string): string {
  return path.join(kbDir, "replay")
}

export function snapshotDir(kbDir: string): string {
  return path.join(replayRoot(kbDir), "snapshot")
}

export function manifestPath(kbDir: string): string {
  return path.join(snapshotDir(kbDir), "manifest.json")
}

export function recordsDir(kbDir: string): string {
  return path.join(snapshotDir(kbDir), "records")
}

export function mediaDir(kbDir: string): string {
  return path.join(snapshotDir(kbDir), "media")
}

export function transcriptsDir(kbDir: string): string {
  return path.join(snapshotDir(kbDir), "transcripts")
}

export function incomingDir(kbDir: string): string {
  return path.join(snapshotDir(kbDir), "_incoming")
}

export function resultsDir(kbDir: string): string {
  return path.join(replayRoot(kbDir), "results")
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(data, null, 1), "utf8")
  await fsp.rename(tmp, file)
}

export async function readReplayManifest(
  kbDir: string,
): Promise<{ ok: true; manifest: ReplayManifest | null } | { ok: false; error: string }> {
  const file = manifestPath(kbDir)
  let text: string
  try {
    text = await fsp.readFile(file, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, manifest: null }
    return { ok: false, error: `快照读不了：${(e as Error).message}` }
  }
  try {
    const json = JSON.parse(text) as ReplayManifest
    if (json?.version !== 1 || !Array.isArray(json.records)) {
      return { ok: false, error: "快照格式不对（manifest.json 不是 version 1），需要重新刷新快照" }
    }
    return { ok: true, manifest: json }
  } catch {
    return { ok: false, error: "快照文件损坏（manifest.json 解析失败），需要重新刷新快照" }
  }
}

export async function writeReplayManifest(kbDir: string, manifest: ReplayManifest): Promise<void> {
  await writeJsonAtomic(manifestPath(kbDir), manifest)
}

export function recordDetailPath(kbDir: string, r: string): string {
  return path.join(recordsDir(kbDir), `${r}.json`)
}

export async function readRecordDetail(kbDir: string, r: string): Promise<ReplayRecordDetail | null> {
  try {
    return JSON.parse(await fsp.readFile(recordDetailPath(kbDir, r), "utf8")) as ReplayRecordDetail
  } catch {
    return null
  }
}

export async function writeRecordDetail(kbDir: string, detail: ReplayRecordDetail): Promise<void> {
  await writeJsonAtomic(recordDetailPath(kbDir, detail.r), detail)
}

export async function listRecordDetails(kbDir: string): Promise<ReplayRecordDetail[]> {
  let names: string[]
  try {
    names = await fsp.readdir(recordsDir(kbDir))
  } catch {
    return []
  }
  const out: ReplayRecordDetail[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const detail = await readRecordDetail(kbDir, name.slice(0, -".json".length))
    if (detail) out.push(detail)
  }
  return out
}

// ——— 截图与转写（按内容哈希命名、去重） ————————————————

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 32)
}

export async function fileSha256(file: string): Promise<string> {
  return sha256Hex(await fsp.readFile(file))
}

export function shotExtension(file: string): string {
  const ext = path.extname(file).toLowerCase()
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(ext) ? ext : ".jpg"
}

/**
 * 把一张截图复制进快照（media/<hash>.<ext>）。
 * 同一内容只存一份：目标已存在就不再写。
 */
export async function importMediaFrom({
  sourceFile,
  kbDir,
  hash,
}: {
  sourceFile: string
  kbDir: string
  hash?: string
}): Promise<{ hash: string; file: string; bytes: number; copied: boolean }> {
  const buf = await fsp.readFile(sourceFile)
  const contentHash = hash ?? sha256Hex(buf)
  const ext = shotExtension(sourceFile)
  const rel = `media/${contentHash}${ext}`
  const target = path.join(snapshotDir(kbDir), rel)
  const exists = fs.existsSync(target)
  if (!exists) {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, buf)
  }
  return { hash: contentHash, file: rel, bytes: buf.length, copied: !exists }
}

/** 逐图转写复制进快照（transcripts/<截图哈希>.json），同一张图只存一份。 */
export async function importTranscriptFrom({
  sourceFile,
  kbDir,
  hash,
}: {
  sourceFile: string
  kbDir: string
  hash: string
}): Promise<{ file: string; bytes: number; copied: boolean }> {
  const buf = await fsp.readFile(sourceFile)
  const rel = `transcripts/${hash}.json`
  const target = path.join(snapshotDir(kbDir), rel)
  const exists = fs.existsSync(target)
  if (!exists) {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, buf)
  }
  return { file: rel, bytes: buf.length, copied: !exists }
}

export function snapshotFileExists(kbDir: string, rel: string | undefined): boolean {
  if (!rel) return false
  return fs.existsSync(path.join(snapshotDir(kbDir), rel))
}

// ——— T25 缓存（只作为导入来源，删掉也不影响快照） ————————————————

export type T25Cache = {
  workDir: string
  imagesDir: string
  transcriptsDir: string
  /** recordId → { seq, attachments: [{token, name, kind, file, size}] } */
  records: Record<string, { seq?: number; attachments: { token: string; name?: string; kind?: string; file?: string; size?: number }[] }>
}

export async function loadT25Cache(workDir: string): Promise<T25Cache | null> {
  const indexFile = path.join(workDir, "index.json")
  let json: { records?: T25Cache["records"] }
  try {
    json = JSON.parse(await fsp.readFile(indexFile, "utf8"))
  } catch {
    return null
  }
  if (!json?.records) return null
  return {
    workDir,
    imagesDir: path.join(workDir, "images"),
    transcriptsDir: path.join(workDir, "transcripts"),
    records: json.records,
  }
}

/** T25 缓存里这张图下载好的文件（没有就返回 null）。 */
export function cachedImageFile(cache: T25Cache | null, recordId: string, token: string): string | null {
  if (!cache) return null
  const entry = cache.records[recordId]
  const att = entry?.attachments?.find((a) => a.token === token)
  if (!att?.file) return null
  const file = path.join(cache.workDir, att.file)
  return fs.existsSync(file) ? file : null
}

/** T25 缓存里这张图的逐图转写（没有就返回 null）。 */
export function cachedTranscriptFile(cache: T25Cache | null, token: string): string | null {
  if (!cache) return null
  const file = path.join(cache.transcriptsDir, `${token}.json`)
  return fs.existsSync(file) ? file : null
}

export function t25SeqMap(cache: T25Cache | null): Record<string, number> {
  const out: Record<string, number> = {}
  if (!cache) return out
  for (const [recordId, entry] of Object.entries(cache.records)) {
    if (typeof entry?.seq === "number" && entry.seq > 0) out[recordId] = entry.seq
  }
  return out
}

/** 从 T25 缓存里抽平均用量，用来估算新图费用（只读，不打印内容）。 */
export async function sampleUsageFromCache(
  cache: T25Cache | null,
  limit = 40,
): Promise<{ promptTokens: number; completionTokens: number; ms: number }[]> {
  if (!cache) return []
  let names: string[] = []
  try {
    names = (await fsp.readdir(cache.transcriptsDir)).filter((n) => n.endsWith(".json")).slice(0, limit)
  } catch {
    return []
  }
  const out: { promptTokens: number; completionTokens: number; ms: number }[] = []
  for (const name of names) {
    try {
      const t = JSON.parse(await fsp.readFile(path.join(cache.transcriptsDir, name), "utf8")) as {
        usage?: { promptTokens?: number; completionTokens?: number }
        ms?: number
      }
      out.push({
        promptTokens: Number(t?.usage?.promptTokens ?? 0),
        completionTokens: Number(t?.usage?.completionTokens ?? 0),
        ms: Number(t?.ms ?? 0),
      })
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out
}

// ——— T27 结果 → 测试状态 ————————————————

/**
 * 扫 replay/results/<recordId>/*.json，得出每条记录的状态。
 * T26 阶段这个目录不存在，所以全部是「未测」。
 */
export async function readReplayStatuses(kbDir: string): Promise<Map<string, ReplayStatus>> {
  const root = resultsDir(kbDir)
  const out = new Map<string, ReplayStatus>()
  let dirs: string[]
  try {
    dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return out
  }
  for (const recordId of dirs) {
    const dir = path.join(root, recordId)
    let runs: { issues?: unknown }[] = []
    try {
      const names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".json"))
      for (const name of names) {
        try {
          runs.push(JSON.parse(await fsp.readFile(path.join(dir, name), "utf8")))
        } catch {
          /* 坏结果跳过 */
        }
      }
    } catch {
      runs = []
    }
    out.set(recordId, deriveReplayStatus(runs))
  }
  return out
}
