import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  legacyReplayConfigPath,
  loadCompanyPrefixes,
  loadSpeakersSettings,
  normalizeSpeakersSettings,
  saveSpeakersSettings,
  speakersConfigPath,
} from "./speakers-config"

let root = ""

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "speakers-config-test-"))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(data), "utf8")
}

describe("loadSpeakersSettings", () => {
  it("没有配置文件时是空设置", async () => {
    const kb = path.join(root, "kb-none")
    const loaded = await loadSpeakersSettings(kb)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.source).toBe("none")
    expect(loaded.settings).toEqual({ myNicknames: [], companyPrefixes: [] })
  })

  it("只有旧 replay.json 时读旧文件（不删、不改）", async () => {
    const kb = path.join(root, "kb-legacy")
    await writeJson(legacyReplayConfigPath(kb), { myNicknames: ["张三", "小张"], updatedAt: "2026-11-01T00:00:00.000Z" })
    const loaded = await loadSpeakersSettings(kb)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.source).toBe("replay")
    expect(loaded.settings.myNicknames).toEqual(["张三", "小张"])
    expect(loaded.settings.companyPrefixes).toEqual([])
    // 旧文件还在
    await expect(fs.readFile(legacyReplayConfigPath(kb), "utf8")).resolves.toContain("张三")
  })

  it("新文件优先于旧文件", async () => {
    const kb = path.join(root, "kb-both")
    await writeJson(legacyReplayConfigPath(kb), { myNicknames: ["旧昵称"] })
    await writeJson(speakersConfigPath(kb), { myNicknames: ["新昵称"], companyPrefixes: ["星图"] })
    const loaded = await loadSpeakersSettings(kb)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.source).toBe("speakers")
    expect(loaded.settings.myNicknames).toEqual(["新昵称"])
    expect(loaded.settings.companyPrefixes).toEqual(["星图"])
  })

  it("新文件坏掉时直接报错，不当成空设置（免得把昵称丢掉）", async () => {
    const kb = path.join(root, "kb-broken")
    await fs.mkdir(path.join(kb, "config"), { recursive: true })
    await fs.writeFile(speakersConfigPath(kb), "{ 坏 JSON", "utf8")
    const loaded = await loadSpeakersSettings(kb)
    expect(loaded.ok).toBe(false)
    if (loaded.ok) return
    expect(loaded.error).toContain("speakers.json")
  })

  it("loadCompanyPrefixes 读不到就返回空数组", async () => {
    expect(await loadCompanyPrefixes(path.join(root, "kb-none2"))).toEqual([])
  })
})

describe("saveSpeakersSettings", () => {
  it("写到 speakers.json，不动 replay.json", async () => {
    const kb = path.join(root, "kb-save")
    await writeJson(legacyReplayConfigPath(kb), { myNicknames: ["旧昵称"] })
    const before = await fs.readFile(legacyReplayConfigPath(kb), "utf8")

    const saved = await saveSpeakersSettings(kb, { myNicknames: "张三、 小张,张三", companyPrefixes: "_星图_、星图" })
    expect(saved.myNicknames).toEqual(["张三", "小张"])
    expect(saved.companyPrefixes).toEqual(["星图"])
    expect(saved.updatedAt).toBeTruthy()

    const onDisk = JSON.parse(await fs.readFile(speakersConfigPath(kb), "utf8"))
    expect(onDisk.myNicknames).toEqual(["张三", "小张"])
    expect(onDisk.companyPrefixes).toEqual(["星图"])
    // 旧文件一个字节都没动
    expect(await fs.readFile(legacyReplayConfigPath(kb), "utf8")).toBe(before)
  })

  it("保存后读回来是新文件", async () => {
    const kb = path.join(root, "kb-save2")
    await saveSpeakersSettings(kb, { myNicknames: "张三", companyPrefixes: "" })
    const loaded = await loadSpeakersSettings(kb)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.source).toBe("speakers")
    expect(loaded.settings.companyPrefixes).toEqual([])
  })
})

describe("normalizeSpeakersSettings", () => {
  it("昵称和前缀都去重、去空白", () => {
    const s = normalizeSpeakersSettings({ myNicknames: ["张三", " 张三 ", "小张"], companyPrefixes: ["星图", "星图", ""] })
    expect(s.myNicknames).toEqual(["张三", "小张"])
    expect(s.companyPrefixes).toEqual(["星图"])
  })

  it("字符串输入也能洗", () => {
    const s = normalizeSpeakersSettings({ myNicknames: "张三、小张", companyPrefixes: "星图 云图" })
    expect(s.myNicknames).toEqual(["张三", "小张"])
    expect(s.companyPrefixes).toEqual(["星图", "云图"])
  })

  it("超长前缀丢掉", () => {
    const s = normalizeSpeakersSettings({ companyPrefixes: ["一二三四五六七八九十一二三四五六七八九十一"] })
    expect(s.companyPrefixes).toEqual([])
  })
})
