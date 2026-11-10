/**
 * T15：粘贴一次出现两张图。
 *
 * 原因（代码层可证）：一次粘贴的 payload 里同一张图会出现两次——`clipboardData.items`
 * （kind=file）一次、`clipboardData.files` 再一次。旧实现从 items 取完再从 files 取，
 * 靠 `名称-大小-lastModified-类型` 去重；剪贴板图片的 File 是浏览器现造的（名字固定
 * `image.png`，lastModified 取创建那一刻），两次拿到的对象不一定相同，键对不上就都进了
 * 截图列表。两个粘贴监听（拖放区 onPaste、window paste）万一同时处理同一个事件，也会
 * 各加一次，而旧去重只存在于单次调用的局部变量里，跨调用无效。
 *
 * 所以这里改成按内容去重：图片先统一压缩成 JPEG，再对字节求指纹（安全上下文用
 * SHA-256，局域网 http 访问等非安全上下文用两个 32 位哈希拼起来兜底）。指纹相同的图片
 * 视为同一张，不管文件名、大小字段怎么变。已知集合 known 记录加进列表的图，pending
 * 记录正在压缩/哈希的图，后者的存在是为了让并发进来的第二次调用也看得到。
 */

export type ImageIntake = {
  /** 已经加进截图列表的图片指纹 */
  known: Set<string>
  /** 正在压缩/哈希中的指纹，挡住并发调用重复加入 */
  pending: Set<string>
}

export type PreparedImage = { file: File; fingerprint: string }

export function createIntake(): ImageIntake {
  return { known: new Set(), pending: new Set() }
}

/** 图片真的进了列表之后调用：指纹从「正在处理」转成「已加入」。 */
export function commitImages(intake: ImageIntake, fingerprints: readonly string[]): void {
  for (const fp of fingerprints) {
    intake.pending.delete(fp)
    intake.known.add(fp)
  }
}

/** 用户删掉截图后调用，允许同一张图再粘一次。 */
export function forgetImage(intake: ImageIntake, fingerprint: string): void {
  intake.pending.delete(fingerprint)
  intake.known.delete(fingerprint)
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

/** 32 位 FNV-1a：`crypto.subtle` 在非安全上下文不可用（http + 局域网 IP），用它兜底。 */
function fnv1a32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5
  for (const b of bytes) {
    hash ^= b
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 32 位 djb2，和 FNV-1a 拼成 64 位宽度，进一步降低误判（一批截图最多 9 张，够用）。 */
function djb232(bytes: Uint8Array): number {
  let hash = 5381
  for (const b of bytes) hash = (Math.imul(hash, 33) + b) >>> 0
  return hash >>> 0
}

function hex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0")
}

/** 按字节内容算图片指纹：同一张图（哪怕来自不同剪贴板格式）压缩后字节一致，指纹就一致。 */
export async function digestImage(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes)
    return `sha256:${toHex(new Uint8Array(digest))}`
  }
  return `fnv:${hex32(fnv1a32(bytes))}${hex32(djb232(bytes))}`
}

/** 从粘贴 payload 里取出图片文件：items 和 files 都看，重复由指纹那一步处理。 */
export function filesFromClipboardData(
  data: Pick<DataTransfer, "items" | "files"> | null | undefined,
): File[] {
  if (!data) return []
  const out: File[] = []
  if (data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile()
        if (f) out.push(f)
      }
    }
  }
  if (data.files?.length) {
    for (const f of Array.from(data.files)) {
      if (f.type.startsWith("image/")) out.push(f)
    }
  }
  return out
}

/**
 * 过滤出真正的新图片：同一次调用内的重复、以及已经加进列表的图片都丢掉。
 * `prepare` 负责压缩并算指纹，默认直接对原文件算。逐张串行处理，保证第二张能看到
 * 第一张刚登记的指纹；判重和登记之间不 await，所以并发调用也不会同时通过。
 */
export async function admitImages(
  intake: ImageIntake,
  files: readonly File[],
  prepare: (file: File) => Promise<PreparedImage> = async (file) => ({
    file,
    fingerprint: await digestImage(file),
  }),
): Promise<{ accepted: PreparedImage[]; duplicates: number }> {
  const accepted: PreparedImage[] = []
  let duplicates = 0
  for (const file of files) {
    let prepared: PreparedImage
    try {
      prepared = await prepare(file)
    } catch {
      // 压缩失败（少见格式、内存不足）就退回原文件，宁可多传一张也别把图丢了
      prepared = { file, fingerprint: await digestImage(file) }
    }
    const fp = prepared.fingerprint
    if (intake.known.has(fp) || intake.pending.has(fp)) {
      duplicates += 1
      continue
    }
    intake.pending.add(fp)
    accepted.push({ file: prepared.file, fingerprint: fp })
  }
  return { accepted, duplicates }
}
