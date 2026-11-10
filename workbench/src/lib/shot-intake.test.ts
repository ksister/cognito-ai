import { afterEach, describe, expect, it, vi } from "vitest"
import {
  admitImages,
  commitImages,
  createIntake,
  digestImage,
  filesFromClipboardData,
  forgetImage,
  type PreparedImage,
} from "./shot-intake"

/** 剪贴板里的图片：浏览器现造的 File，名字固定、lastModified 取创建时刻。 */
function clipboardImage(bytes: number[], opts: { name?: string; lastModified?: number } = {}): File {
  return new File([new Uint8Array(bytes)], opts.name ?? "image.png", {
    type: "image/png",
    lastModified: opts.lastModified ?? 1_700_000_000_000,
  })
}

/** 真实链路里是「压缩成统一 JPEG 再算指纹」，测试里压缩换成原样返回。 */
async function identityPrepare(file: File): Promise<PreparedImage> {
  return { file, fingerprint: await digestImage(file) }
}

const SHOT_A = [137, 80, 78, 71, 1, 2, 3, 4]
const SHOT_B = [137, 80, 78, 71, 9, 8, 7, 6]

describe("T15 粘贴去重", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("同一次粘贴里 items 和 files 各列一份（File 对象不同），只收一张", async () => {
    // 复现 T15：一次粘贴，items 和 files 各给一个 File，lastModified 差 1ms
    const data = {
      items: [{ kind: "file", type: "image/png", getAsFile: () => clipboardImage(SHOT_A, { lastModified: 1 }) }],
      files: [clipboardImage(SHOT_A, { lastModified: 2 })],
    } as unknown as DataTransfer

    const files = filesFromClipboardData(data)
    expect(files).toHaveLength(2) // 两个入口都列了这张图
    expect(files[0]).not.toBe(files[1]) // 是两个不同的 File 对象

    const intake = createIntake()
    const { accepted, duplicates } = await admitImages(intake, files, identityPrepare)
    expect(accepted).toHaveLength(1)
    expect(duplicates).toBe(1)
  })

  it("文件名、lastModified、类型都不同但内容相同时算同一张", async () => {
    const intake = createIntake()
    const first = clipboardImage(SHOT_A, { name: "image.png", lastModified: 1 })
    const second = clipboardImage(SHOT_A, { name: "截图.png", lastModified: 99 })
    const { accepted, duplicates } = await admitImages(intake, [first, second], identityPrepare)
    expect(accepted).toHaveLength(1)
    expect(duplicates).toBe(1)
  })

  it("连续粘贴 20 次同一张图，列表里只有一张", async () => {
    const intake = createIntake()
    const shown: string[] = []
    for (let i = 0; i < 20; i++) {
      // 每次粘贴都是一个新的 File 对象，只有内容一样
      const { accepted } = await admitImages(
        intake,
        [clipboardImage(SHOT_A, { lastModified: 100 + i })],
        identityPrepare,
      )
      commitImages(intake, accepted.map((a) => a.fingerprint))
      shown.push(...accepted.map((a) => a.fingerprint))
    }
    expect(shown).toHaveLength(1)
    expect(intake.known.size).toBe(1)
  })

  it("两个粘贴监听同时处理同一个事件，也只收一张", async () => {
    const intake = createIntake()
    const slow = async (file: File): Promise<PreparedImage> => {
      await new Promise((r) => setTimeout(r, 5))
      return identityPrepare(file)
    }
    const [first, second] = await Promise.all([
      admitImages(intake, [clipboardImage(SHOT_A)], slow),
      admitImages(intake, [clipboardImage(SHOT_A)], slow),
    ])
    expect(first.accepted.length + second.accepted.length).toBe(1)
    expect(first.duplicates + second.duplicates).toBe(1)
  })

  it("内容不同的图都收下，顺序不变", async () => {
    const intake = createIntake()
    const { accepted, duplicates } = await admitImages(
      intake,
      [clipboardImage(SHOT_A), clipboardImage(SHOT_B)],
      identityPrepare,
    )
    expect(duplicates).toBe(0)
    expect(accepted).toHaveLength(2)
    expect(accepted.map((a) => a.fingerprint)).toEqual([
      await digestImage(clipboardImage(SHOT_A)),
      await digestImage(clipboardImage(SHOT_B)),
    ])
  })

  it("删掉截图后同一张图能再粘一次", async () => {
    const intake = createIntake()
    const first = await admitImages(intake, [clipboardImage(SHOT_A)], identityPrepare)
    commitImages(intake, first.accepted.map((a) => a.fingerprint))

    const blocked = await admitImages(intake, [clipboardImage(SHOT_A)], identityPrepare)
    expect(blocked.accepted).toHaveLength(0)

    forgetImage(intake, first.accepted[0].fingerprint)
    const again = await admitImages(intake, [clipboardImage(SHOT_A)], identityPrepare)
    expect(again.accepted).toHaveLength(1)
    expect(again.duplicates).toBe(0)
  })

  it("压缩失败时退回原文件，仍然按内容去重", async () => {
    const intake = createIntake()
    const boom = async (): Promise<PreparedImage> => {
      throw new Error("createImageBitmap 不支持这个格式")
    }
    const first = await admitImages(intake, [clipboardImage(SHOT_A)], boom)
    expect(first.accepted).toHaveLength(1)
    expect(first.accepted[0].fingerprint).toMatch(/^(sha256|fnv):/)
    const second = await admitImages(intake, [clipboardImage(SHOT_A)], boom)
    expect(second.accepted).toHaveLength(0)
    expect(second.duplicates).toBe(1)
  })

  it("非安全上下文（没有 crypto.subtle）走兜底哈希，同样能去重", async () => {
    vi.stubGlobal("crypto", {})
    const fp = await digestImage(clipboardImage(SHOT_A))
    expect(fp.startsWith("fnv:")).toBe(true)
    expect(await digestImage(clipboardImage(SHOT_A))).toBe(fp)
    expect(await digestImage(clipboardImage(SHOT_B))).not.toBe(fp)

    const intake = createIntake()
    const { accepted, duplicates } = await admitImages(
      intake,
      [clipboardImage(SHOT_A), clipboardImage(SHOT_A, { lastModified: 5 })],
      identityPrepare,
    )
    expect(accepted).toHaveLength(1)
    expect(duplicates).toBe(1)
  })

  it("指纹按内容走：同一份字节稳定，不同字节不同", async () => {
    const a1 = await digestImage(clipboardImage(SHOT_A))
    const a2 = await digestImage(clipboardImage(SHOT_A, { name: "别的名字.png", lastModified: 42 }))
    const b = await digestImage(clipboardImage(SHOT_B))
    expect(a1.startsWith("sha256:")).toBe(true)
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
  })

  it("从粘贴 payload 取图：跳过非图片、没有数据的项和空 payload", () => {
    const data = {
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => clipboardImage(SHOT_A) },
        { kind: "file", type: "image/png", getAsFile: () => null },
        {
          kind: "file",
          type: "application/pdf",
          getAsFile: () => new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" }),
        },
      ],
      files: [new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" })],
    } as unknown as DataTransfer
    expect(filesFromClipboardData(data)).toHaveLength(1)
    expect(filesFromClipboardData(null)).toHaveLength(0)
    expect(filesFromClipboardData({ items: [], files: [] } as unknown as DataTransfer)).toHaveLength(0)
  })
})
