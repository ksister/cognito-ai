#!/usr/bin/env node
// kb-peek：核对 KB_DIR（或任何目录）里的数据时**只准用它**（AGENTS.md 硬规则）。
//
// 用法：
//   node scripts/kb-peek.mjs <文件或目录> [--depth N]
//
// 输出只有：文件数、总大小、每个文件的相对路径和字节数、JSON 的键名和数组长度。
// **绝不输出字段值**——不打印字符串、不打印数字、不打印 md 正文。
//
// 想确认「某个字段在不在」「有几条」「结构对不对」，看键名和长度就够了；
// 真要看内容，由用户自己在编辑器里看，不要经过这个会话。

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** JSON 结构最多描述到第几层（再深只列键名）。 */
const MAX_JSON_DEPTH = 2
/** 单个目录最多列多少个文件。 */
const MAX_FILES = 2000

function typeName(value) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/** 只描述结构，不泄露值：值一律换成类型名。 */
export function describeJson(value, depth = 0) {
  if (value === null) return "null"
  if (Array.isArray(value)) {
    const head = `array(${value.length})`
    if (!value.length || depth >= MAX_JSON_DEPTH) return head
    const sample = value[0]
    if (sample && typeof sample === "object") return `${head} of ${describeJson(sample, depth + 1)}`
    return `${head} of ${typeName(sample)}`
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort()
    if (!keys.length) return "object{}"
    if (depth >= MAX_JSON_DEPTH) return `object{${keys.join(",")}}`
    return `object{${keys.map((k) => `${k}:${describeJson(value[k], depth + 1)}`).join(",")}}`
  }
  return typeName(value)
}

export function describeJsonText(text) {
  try {
    return describeJson(JSON.parse(text))
  } catch {
    return "（不是合法 JSON，未解析）"
  }
}

function walk(target, out, depth, maxDepth) {
  let st
  try {
    st = fs.statSync(target)
  } catch {
    return
  }
  if (st.isFile()) {
    out.push({ file: target, bytes: st.size })
    return
  }
  if (!st.isDirectory()) return
  if (depth > maxDepth) {
    out.push({ file: target + path.sep, bytes: 0, dir: true })
    return
  }
  for (const name of fs.readdirSync(target).sort()) {
    if (out.length >= MAX_FILES) return
    walk(path.join(target, name), out, depth + 1, maxDepth)
  }
}

/**
 * 列出目录/文件的结构摘要。返回的行里只有路径、字节数、JSON 结构。
 */
export function peek(target, { baseDir = process.cwd(), maxDepth = 6 } = {}) {
  const abs = path.resolve(target)
  if (!fs.existsSync(abs)) throw new Error("路径不存在")
  const st = fs.statSync(abs)
  const files = []
  walk(abs, files, 0, st.isDirectory() ? maxDepth : 0)

  const totalBytes = files.reduce((n, f) => n + (f.bytes || 0), 0)
  const lines = [
    `路径：${path.relative(baseDir, abs) || "."}`,
    `文件数：${files.length}${files.length >= MAX_FILES ? `（只列了前 ${MAX_FILES} 个）` : ""}`,
    `总大小：${totalBytes} 字节`,
  ]
  for (const f of files) {
    const rel = path.relative(baseDir, f.file)
    if (f.dir) {
      lines.push(`- ${rel} （目录，未展开）`)
      continue
    }
    let line = `- ${rel} · ${f.bytes} 字节`
    if (rel.toLowerCase().endsWith(".json")) {
      try {
        line += ` · ${describeJsonText(fs.readFileSync(f.file, "utf8"))}`
      } catch {
        line += " · （读不了）"
      }
    }
    lines.push(line)
  }
  return { files: files.length, totalBytes, lines }
}

const USAGE = [
  "用法：node scripts/kb-peek.mjs <文件或目录> [--depth N]",
  "只输出文件数、大小、相对路径、JSON 键名和数组长度；不输出任何字段值。",
].join("\n")

function main(argv) {
  const args = argv.slice(2)
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE)
    process.exit(args.length ? 0 : 2)
  }
  const depthAt = args.indexOf("--depth")
  const maxDepth = depthAt >= 0 ? Number(args[depthAt + 1]) || 2 : 6
  const target = args[0]
  console.log(peek(target, { maxDepth }).lines.join("\n"))
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    main(process.argv)
  } catch (e) {
    console.error(`kb-peek 失败：${e.message}`)
    process.exit(1)
  }
}
