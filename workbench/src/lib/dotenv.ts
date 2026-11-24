import fs from "node:fs"

/** 读 .env.local（不覆盖环境里已有的值）；只解析 KEY=VALUE。脚本用，不打印任何值。 */
export function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    if (process.env[m[1]] !== undefined) continue
    let v = m[2].trim()
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1)
    }
    process.env[m[1]] = v
  }
}
