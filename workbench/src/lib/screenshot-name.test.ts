import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { emptyDraft } from "./types"
import { allocateScreenshotNames, screenshotStem, unlinkedFileNames } from "./screenshot-name"

const TITLE = "手机中框读码率低"
const DATE = "2026-10-15"

describe("screenshot names", () => {
  it("uses the chat date and the first 20 characters of the title", () => {
    const long = "一二三四五六七八九十一二三四五六七八九十尾"
    expect(Array.from(long)).toHaveLength(21)
    expect(screenshotStem(DATE, long)).toBe(`2026-10-15-${Array.from(long).slice(0, 20).join("")}`)
    expect(screenshotStem(DATE, "读码/率*低")).toBe("2026-10-15-读码-率-低")
    expect(allocateScreenshotNames([], DATE, TITLE, 3)).toEqual([
      "2026-10-15-手机中框读码率低-1.jpg",
      "2026-10-15-手机中框读码率低-2.jpg",
      "2026-10-15-手机中框读码率低-3.jpg",
    ])
  })

  it("bumps the index on collision and does not reuse legacy names", () => {
    const taken = ["截图-20261015-1.jpg", "2026-10-15-手机中框读码率低-1.jpg"]
    expect(allocateScreenshotNames(taken, DATE, TITLE, 2)).toEqual([
      "2026-10-15-手机中框读码率低-2.jpg",
      "2026-10-15-手机中框读码率低-3.jpg",
    ])
    expect(unlinkedFileNames(["截图-20261015-1.jpg", "2026-10-15-手机中框读码率低-1.jpg", "日志.txt"], ["2026-10-15-手机中框读码率低-1.jpg"])).toEqual([
      "截图-20261015-1.jpg",
      "日志.txt",
    ])
  })
})

describe("saved screenshots", () => {
  let tmp = ""

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  it("writes three dated files into frontmatter and leaves legacy names alone", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "t3-kb-"))
    process.env.KB_DIR = tmp
    const kb = await import("./kb")
    const customer = "T3Fixture"
    const rec = await kb.createRecord({
      ...emptyDraft(customer),
      title: TITLE,
      date: DATE,
      problem: "读码率低",
    })
    const filesDir = path.join(tmp, "customers", customer, "files")
    const { mkdir } = await import("node:fs/promises")
    await mkdir(filesDir, { recursive: true })
    const legacy = path.join(filesDir, "截图-20261015-1.jpg")
    await writeFile(legacy, Buffer.from("legacy"))

    const names = await kb.saveScreenshotBatch(customer, [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")], {
      date: rec.date,
      title: rec.title,
    })
    expect(names).toEqual([
      "2026-10-15-手机中框读码率低-1.jpg",
      "2026-10-15-手机中框读码率低-2.jpg",
      "2026-10-15-手机中框读码率低-3.jpg",
    ])
    expect(names.some((n) => n.startsWith("2026-10-30"))).toBe(false)
    for (const name of names) {
      const body = await readFile(path.join(filesDir, name))
      expect(body.length).toBeGreaterThan(0)
    }
    expect((await readFile(legacy)).toString()).toBe("legacy")

    const updated = await kb.updateRecord(customer, rec.file.replace(/\.md$/, ""), { screenshots: names })
    expect(updated.screenshots).toEqual(names)
    const md = await readFile(path.join(tmp, "customers", customer, "records", rec.file), "utf8")
    for (const name of names) expect(md).toContain(name)
    const loaded = await kb.getRecord(customer, rec.file.replace(/\.md$/, ""))
    expect(loaded?.screenshots).toEqual(names)
  })
})
