import fs from "node:fs/promises"
import path from "node:path"
import { isValidReplayR } from "@/lib/replay-model"
import { readRecordDetail, snapshotDir } from "@/lib/replay-store"
import { resolveKbRoot } from "@/lib/feishu-schema-load"

export const dynamic = "force-dynamic"

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
}

/**
 * 对比页左边显示的快照截图（T27）。
 * 只从 `replay/snapshot/` 里读当前这条记录引用的图片，不碰 KB 其它目录；
 * 记录 ID 和序号都先校验，路径必须落在 snapshot 目录内。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ r: string; i: string }> }) {
  const { r, i } = await params
  if (!isValidReplayR(r)) return new Response("R 编号不合法", { status: 400 })
  const index = Number(i)
  if (!Number.isInteger(index) || index < 0 || index > 200) return new Response("截图序号不合法", { status: 400 })

  const kbDir = resolveKbRoot()
  const detail = await readRecordDetail(kbDir, r)
  const shot = detail?.shots?.[index]
  if (!detail || !shot) return new Response("没有这张截图", { status: 404 })

  const root = snapshotDir(kbDir)
  const file = path.resolve(root, shot.file)
  if (!file.startsWith(path.resolve(root) + path.sep)) return new Response("路径不合法", { status: 400 })

  try {
    const buf = await fs.readFile(file)
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "private, max-age=3600",
      },
    })
  } catch {
    return new Response("截图文件读不到", { status: 404 })
  }
}
