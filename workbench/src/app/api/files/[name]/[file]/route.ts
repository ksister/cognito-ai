import fs from "node:fs/promises"
import { filePath } from "@/lib/kb"

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
}

export async function GET(_req: Request, { params }: { params: Promise<{ name: string; file: string }> }) {
  const { name, file } = await params
  const fileName = decodeURIComponent(file)
  try {
    const data = await fs.readFile(filePath(decodeURIComponent(name), fileName))
    const ext = fileName.split(".").pop()?.toLowerCase() ?? ""
    return new Response(data, {
      headers: {
        "Content-Type": TYPES[ext] ?? "application/octet-stream",
        "Content-Disposition": `${TYPES[ext] ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      },
    })
  } catch {
    return new Response("文件不存在", { status: 404 })
  }
}
