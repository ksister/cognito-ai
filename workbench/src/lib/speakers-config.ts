import fs from "node:fs/promises"
import path from "node:path"
import { parseCompanyPrefixes, parseNicknames } from "./replay-model.ts"

/**
 * T27 PR2：发言人判断的私有配置 KB_DIR/config/speakers.json（不进仓库）。
 *
 *   { "myNicknames": ["张三", "小张"], "companyPrefixes": ["星图"], "updatedAt": "..." }
 *
 * - 主流程转写和回放共用这一份。
 * - 兼容旧文件：speakers.json 不存在时读 config/replay.json 的 myNicknames（T26 存的），
 *   不删旧文件；设置页保存时只写 speakers.json。
 *
 * Script-safe: no `server-only`, `.ts` suffix on relative runtime imports.
 */

export type SpeakersSettings = {
  /** 用户本人在聊天里可能出现的昵称。 */
  myNicknames: string[]
  /** 我方公司名/组织名前缀，微信里常见「星图_张三」。只用于匹配，不改转写原文。 */
  companyPrefixes: string[]
  updatedAt?: string
}

export type SpeakersSource = "speakers" | "replay" | "none"

export type SpeakersLoadResult =
  | { ok: true; settings: SpeakersSettings; source: SpeakersSource }
  | { ok: false; error: string }

export function speakersConfigPath(kbDir: string): string {
  return path.join(kbDir, "config", "speakers.json")
}

/** 旧文件（T26 只存昵称），只读不写。 */
export function legacyReplayConfigPath(kbDir: string): string {
  return path.join(kbDir, "config", "replay.json")
}

/** 统一洗一遍设置（读旧文件、读新文件、保存前都用它）。 */
export function normalizeSpeakersSettings(input: {
  myNicknames?: unknown
  companyPrefixes?: unknown
  updatedAt?: unknown
}): SpeakersSettings {
  const nicknames = Array.isArray(input.myNicknames)
    ? parseNicknames(input.myNicknames.map((n) => String(n)).join(","))
    : parseNicknames(String(input.myNicknames ?? ""))
  const prefixes = Array.isArray(input.companyPrefixes)
    ? parseCompanyPrefixes(input.companyPrefixes.map((n) => String(n)))
    : parseCompanyPrefixes(String(input.companyPrefixes ?? ""))
  return {
    myNicknames: nicknames,
    companyPrefixes: prefixes,
    ...(typeof input.updatedAt === "string" && input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  }
}

/**
 * 读设置：先 speakers.json；没有就退回 replay.json 里的昵称；都没有就是空设置。
 * speakers.json 存在但坏掉时直接报错，不静默当成空（否则会把用户昵称「丢」了）。
 */
export async function loadSpeakersSettings(kbDir: string): Promise<SpeakersLoadResult> {
  const primary = speakersConfigPath(kbDir)
  try {
    const text = await fs.readFile(primary, "utf8")
    const json = JSON.parse(text) as Partial<SpeakersSettings>
    return { ok: true, settings: normalizeSpeakersSettings(json), source: "speakers" }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, error: "config/speakers.json 解析失败，请在设置页重新保存一次「发言人」" }
    }
  }

  try {
    const text = await fs.readFile(legacyReplayConfigPath(kbDir), "utf8")
    const json = JSON.parse(text) as { myNicknames?: unknown; updatedAt?: unknown }
    const legacy = normalizeSpeakersSettings({ myNicknames: json?.myNicknames, updatedAt: json?.updatedAt })
    return { ok: true, settings: legacy, source: "replay" }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, error: "旧配置 config/replay.json 解析失败，请在设置页重新保存一次「发言人」" }
    }
  }

  return { ok: true, settings: { myNicknames: [], companyPrefixes: [] }, source: "none" }
}

/** 只取公司前缀（主流程/回放匹配用；读不到就空数组，不影响转写）。 */
export async function loadCompanyPrefixes(kbDir: string): Promise<string[]> {
  const loaded = await loadSpeakersSettings(kbDir)
  return loaded.ok ? loaded.settings.companyPrefixes : []
}

/** 保存设置（只写 speakers.json；不动 replay.json）。 */
export async function saveSpeakersSettings(
  kbDir: string,
  input: { myNicknames?: string | string[]; companyPrefixes?: string | string[] },
): Promise<SpeakersSettings> {
  const next = normalizeSpeakersSettings({
    myNicknames: input.myNicknames,
    companyPrefixes: input.companyPrefixes,
    updatedAt: new Date().toISOString(),
  })
  const file = speakersConfigPath(kbDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8")
  await fs.rename(tmp, file)
  return next
}
