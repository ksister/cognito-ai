import fs from "node:fs/promises"
import path from "node:path"
import { parseNicknames } from "./replay-model.ts"

/**
 * 回放测试的私有设置：KB_DIR/config/replay.json（不进仓库）。
 * T26 只存「我的昵称」（T27 判断发言人、T29 取「我当时的实际回复」都要用）。
 *
 * Script-safe: no `server-only`, `.ts` suffix on relative runtime imports.
 */

export type ReplaySettings = {
  /** 用户本人在聊天里可能出现的昵称，可多个。 */
  myNicknames: string[]
  updatedAt?: string
}

export function replayConfigPath(kbDir: string): string {
  return path.join(kbDir, "config", "replay.json")
}

export async function loadReplaySettings(
  kbDir: string,
): Promise<{ ok: true; settings: ReplaySettings } | { ok: false; error: string }> {
  const file = replayConfigPath(kbDir)
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, settings: { myNicknames: [] } }
    return { ok: false, error: `配置文件读不了：${(e as Error).message}` }
  }
  try {
    const json = JSON.parse(text) as Partial<ReplaySettings>
    const names = Array.isArray(json?.myNicknames) ? parseNicknames(json.myNicknames.join(",")) : []
    return { ok: true, settings: { myNicknames: names, updatedAt: json?.updatedAt } }
  } catch {
    return { ok: false, error: "配置文件损坏（config/replay.json 解析失败），请重新保存一次昵称" }
  }
}

export async function saveMyNicknames(kbDir: string, input: string | string[]): Promise<ReplaySettings> {
  const names = parseNicknames(Array.isArray(input) ? input.join(",") : input)
  const next: ReplaySettings = { myNicknames: names, updatedAt: new Date().toISOString() }
  const file = replayConfigPath(kbDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8")
  await fs.rename(tmp, file)
  return next
}
