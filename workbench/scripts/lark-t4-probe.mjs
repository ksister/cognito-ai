#!/usr/bin/env node
/**
 * T4 阻塞探测：只在测试表上检查 lark-cli 能否
 *   1. 按 record_id 更新字段
 *   2. 给已有行上传附件
 *   3. 对同一 record_id 再更新一次，且不新建第二行
 *
 * 调用方式与工作台一致：`lark-cli base … --as user --format json`，不经 shell。
 * 更新用官方 `base +record-upsert --record-id`（有 id 则更新，无 id 才创建）。
 * 附件用与 `lark-bitable.ts` 相同的 `base +record-upload-attachment`。
 * lark-cli 1.0.56：`--file` 必须是当前目录下的相对路径（写到 `.tmp/` 再 `path.relative`）。绝对路径会被拒绝。
 * 创建成功后先等 1.5 秒再第一次更新，否则可能返回 800030405 not_found。
 * `+record-upsert` 的 record_id 在 `data.record.record_id_list[0]`，不是 `data.record_id`。
 * `--json @file.json` 必须是不带 BOM 的 UTF-8。PowerShell `Set-Content -Encoding UTF8` 会写入 BOM，CLI 报 invalid character ï。本脚本用 Node 写文件，不带 BOM。
 * 多选字段用字符串数组，例如 {"fldWlbihaw":["尺寸测量","外观检测"]}。
 * 人员字段不能写显示名字符串数组（会 not_found）。用 open_id 对象：{"fldR5MJ3au":[{"id":"ou_…"}]}，写入后界面显示对应人名。
 *
 * 只读写环境变量里的测试表。生产表 LARK_TABLE_ID 只用来比对，绝不传给 CLI。
 *
 * 在仓库根（Windows）：
 *   cd /d C:\Users\TianYun\cognito-ai\workbench
 *   node scripts\lark-t4-probe.mjs
 *
 * 先看计划、不调用飞书：
 *   node scripts\lark-t4-probe.mjs --check
 *
 * 怎么读结果（把整段终端输出发回来）：
 *   - 退出码 0，且三行都是 PASS：这三项在测试表上成立
 *   - 退出码 2：环境被拒绝（缺变量，或测试表 id 等于生产表）。没有写入
 *   - 退出码 1：某一步失败。看 FAIL 那一行和它上面的 CLI 摘要
 *   - `rows_with_marker=1` 且两次 update 的 record_id 相同，才算没有多出一行
 *
 * 必填（写在 workbench/.env.local，不要提交）：
 *   LARK_TEST_TABLE_ID   测试表 id。必须和生产表 LARK_TABLE_ID 不同
 *   LARK_BASE_TOKEN      测试表所在多维表格的 base token
 * 可选：
 *   LARK_TEST_BASE_TOKEN 测试表在另一个 base 时用这个，否则用 LARK_BASE_TOKEN
 *   LARK_TABLE_ID        生产表 id，仅用于拒绝误操作
 *   LARK_TEST_TEXT_FIELD / LARK_TEST_ATTACHMENT_FIELD  测试表字段 id；不设则从 +field-list 里挑
 *   LARK_CLI_PATH        lark-cli 可执行文件
 */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const checkOnly = process.argv.includes("--check")

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, "utf8")
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value
  }
}

function tail4(value) {
  const v = (value || "").trim()
  if (!v) return "(empty)"
  return `…${v.slice(-4)}`
}

export function resolveProbeEnv(env = process.env) {
  const prodTable = (env.LARK_TABLE_ID || "").trim()
  const testTable = (env.LARK_TEST_TABLE_ID || "").trim()
  const testBase = (env.LARK_TEST_BASE_TOKEN || "").trim()
  const base = testBase || (env.LARK_BASE_TOKEN || "").trim()
  const baseSource = testBase ? "LARK_TEST_BASE_TOKEN" : "LARK_BASE_TOKEN"
  if (!testTable) {
    return { ok: false, code: 2, error: "缺少 LARK_TEST_TABLE_ID。探测只允许打测试表。" }
  }
  if (!base) {
    return { ok: false, code: 2, error: "缺少 base token。设置 LARK_TEST_BASE_TOKEN，或沿用测试表所在 base 的 LARK_BASE_TOKEN。" }
  }
  if (prodTable && testTable === prodTable) {
    return {
      ok: false,
      code: 2,
      error: `拒绝执行：LARK_TEST_TABLE_ID 与生产表 LARK_TABLE_ID 相同（${tail4(testTable)}）。请换一张测试表。`,
    }
  }
  return {
    ok: true,
    prodTable,
    testTable,
    base,
    baseSource,
    textField: (env.LARK_TEST_TEXT_FIELD || "").trim(),
    attachmentField: (env.LARK_TEST_ATTACHMENT_FIELD || "").trim(),
    cliPath: (env.LARK_CLI_PATH || "").trim(),
  }
}

function which(name) {
  const cmd = process.platform === "win32" ? "where" : "which"
  const found = spawnSync(cmd, [name], { encoding: "utf8", windowsHide: true })
  if (found.status !== 0) return ""
  return (
    found.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || ""
  )
}

function resolveCli(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) return { error: `LARK_CLI_PATH 不存在：${explicit}` }
    return { path: explicit }
  }
  const fromPath = which("lark-cli") || (process.platform === "win32" ? which("lark-cli.exe") : "")
  if (fromPath) return { path: fromPath }
  return { error: "未找到 lark-cli。安装：npx @larksuite/cli@latest install ，然后 lark-cli config init。或设置 LARK_CLI_PATH。" }
}

function parseCliJson(text) {
  const trimmed = text.trim()
  if (!trimmed) return null
  const candidates = []
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed)
  const match = trimmed.match(/\{[\s\S]*\}\s*$/)
  if (match) candidates.push(match[0])
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* next */
    }
  }
  return null
}

function runCli(cliPath, args) {
  return new Promise((resolve) => {
    const child = spawn(cliPath, args, { shell: false, windowsHide: true, env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (err) => resolve({ exitCode: null, stdout, stderr: `${stderr}\n${err.message}`, json: null }))
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr, json: parseCliJson(stdout) }))
  })
}

function redact(text, secrets) {
  let out = text
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(`…${secret.slice(-4)}`)
  }
  return out.slice(0, 1200)
}

function fieldsOf(json) {
  if (!json) return []
  const data = json.data && typeof json.data === "object" ? json.data : json
  const items = data.items || data.fields || json.items || []
  return Array.isArray(items) ? items : []
}

function fieldId(field) {
  return String(field.field_id || field.id || "")
}

function fieldName(field) {
  return String(field.field_name || field.name || "")
}

function isTextField(field) {
  const type = String(field.type ?? "").toLowerCase()
  const ui = String(field.ui_type || field.uiType || "").toLowerCase()
  return type === "1" || type === "text" || ui === "text"
}

function isAttachmentField(field) {
  const type = String(field.type ?? "").toLowerCase()
  const ui = String(field.ui_type || field.uiType || "").toLowerCase()
  return type === "17" || type === "attachment" || ui === "attachment"
}

export function writeUtf8JsonFile(absPath, value) {
  const text = JSON.stringify(value)
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, text, { encoding: "utf8" })
  const buf = fs.readFileSync(absPath)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    throw new Error("JSON 文件带了 UTF-8 BOM。PowerShell Set-Content -Encoding UTF8 会这样，lark-cli 会报 invalid character ï。")
  }
  return path.relative(process.cwd(), absPath).split(path.sep).join("/")
}

export function recordIdOf(json) {
  if (!json) return ""
  const data = json.data && typeof json.data === "object" ? json.data : json
  if (typeof data.record_id === "string") return data.record_id
  const record = data.record
  if (record && typeof record === "object") {
    if (typeof record.record_id === "string") return record.record_id
    // Live lark-cli +record-upsert: data.record.record_id_list = ["rec…"]
    if (Array.isArray(record.record_id_list) && record.record_id_list[0]) return String(record.record_id_list[0])
  }
  const list = data.record_id_list || json.record_id_list
  if (Array.isArray(list) && list[0]) return String(list[0])
  const records = data.records || data.items || []
  if (Array.isArray(records) && records[0]?.record_id) return String(records[0].record_id)
  return ""
}

function recordCount(json) {
  if (!json) return null
  const data = json.data && typeof json.data === "object" ? json.data : json
  for (const key of ["items", "records", "record_id_list"]) {
    if (Array.isArray(data[key])) return data[key].length
    if (Array.isArray(json[key])) return json[key].length
  }
  if (data.total != null && Number.isFinite(Number(data.total))) return Number(data.total)
  return null
}

async function main() {
  loadEnvFile(path.join(scriptDir, "..", ".env.local"))
  const cfg = resolveProbeEnv()
  if (!cfg.ok) {
    console.error(`REFUSED ${cfg.error}`)
    process.exit(cfg.code)
  }

  console.log("T4-probe")
  console.log(`test_table=${tail4(cfg.testTable)} base_source=${cfg.baseSource} base=${tail4(cfg.base)}`)
  if (!cfg.prodTable) console.log("note=LARK_TABLE_ID 未设置，只确认本次不会读取该变量作为 --table-id")
  else console.log(`prod_table=${tail4(cfg.prodTable)} (not used)`)

  if (checkOnly) {
    console.log("mode=check")
    console.log("plan=field-list → upsert create → upsert --record-id ×2 → upload-attachment → search same marker")
    console.log("writes=none")
    process.exit(0)
  }

  const cli = resolveCli(cfg.cliPath)
  if (!cli.path) {
    console.error(`FAIL cli ${cli.error}`)
    process.exit(1)
  }

  const secrets = [cfg.base, cfg.testTable, cfg.prodTable].filter(Boolean)
  const common = ["--base-token", cfg.base, "--table-id", cfg.testTable, "--as", "user", "--format", "json"]

  async function call(step, args) {
    if (args.includes(cfg.prodTable) && cfg.prodTable && cfg.prodTable !== cfg.testTable) {
      console.error("REFUSED 参数里出现了生产表 id，已中止")
      process.exit(2)
    }
    const tableFlags = args.filter((_, i) => args[i - 1] === "--table-id")
    if (tableFlags.some((id) => id !== cfg.testTable)) {
      console.error("REFUSED --table-id 不是 LARK_TEST_TABLE_ID，已中止")
      process.exit(2)
    }
    console.log(`\nSTEP ${step}`)
    console.log(`cmd=lark-cli ${args.map((part) => (secrets.includes(part) ? tail4(part) : part)).join(" ")}`)
    const run = await runCli(cli.path, args)
    const summary = redact(`${run.stdout}\n${run.stderr}`.trim(), secrets)
    console.log(`exit=${run.exitCode}`)
    if (summary) console.log(summary)
    return run
  }

  const listed = await call("field-list", ["base", "+field-list", ...common])
  const fields = fieldsOf(listed.json)
  let text = fields.find((field) => fieldId(field) === cfg.textField || fieldName(field) === cfg.textField)
  if (!text) text = fields.find(isTextField)
  let attachment = fields.find(
    (field) => fieldId(field) === cfg.attachmentField || fieldName(field) === cfg.attachmentField,
  )
  if (!attachment) attachment = fields.find(isAttachmentField)
  if (!text || !fieldId(text)) {
    console.error("FAIL text_field 测试表上没有可用的文本字段。可设置 LARK_TEST_TEXT_FIELD。")
    process.exit(1)
  }
  const textId = fieldId(text)
  const textLabel = fieldName(text) || textId
  console.log(`text_field=${textLabel} attachment_field=${attachment ? fieldName(attachment) || fieldId(attachment) : "(none)"}`)

  const marker = `T4-probe ${new Date().toISOString()}`
  const jsonFiles = []
  function jsonAt(name, value) {
    const abs = path.join(process.cwd(), ".tmp", name)
    const rel = writeUtf8JsonFile(abs, value)
    jsonFiles.push(abs)
    return `@${rel}`
  }
  try {
  const created = await call("create", [
    "base",
    "+record-upsert",
    ...common.slice(0, 4),
    "--json",
    jsonAt("create.json", { [textId]: `${marker} create` }),
    ...common.slice(4),
  ])
  const recordId = recordIdOf(created.json)
  if (!recordId || created.json?.created === false) {
    console.error("FAIL create 没有拿到 record_id。上面是 CLI 原文。")
    throw new Error("create missing record_id")
  }
  console.log(`record_id=${recordId} created=${created.json?.created ?? "(see output)"}`)
  console.log("wait_ms=1500 reason=immediate update can return 800030405 not_found")
  await new Promise((resolve) => setTimeout(resolve, 1500))

  async function updateOnce(label, value) {
    const run = await call(label, [
      "base",
      "+record-upsert",
      ...common.slice(0, 4),
      "--record-id",
      recordId,
      "--json",
      jsonAt(`${label}.json`, { [textId]: value }),
      ...common.slice(4),
    ])
    const id = recordIdOf(run.json) || recordId
    const updated = run.json?.updated
    const pass = run.exitCode === 0 && updated !== false && id === recordId
    console.log(`${pass ? "PASS" : "FAIL"} ${label} updated=${updated ?? "(missing)"} record_id=${id}`)
    return pass
  }

  const pass1 = await updateOnce("update_by_record_id", `${marker} update-1`)
  const pass2 = await updateOnce("second_update_same_record_id", `${marker} update-2`)

  let passAttach = false
  if (!attachment || !fieldId(attachment)) {
    console.error("FAIL upload_attachment 测试表没有附件字段。可设置 LARK_TEST_ATTACHMENT_FIELD 为该表自己的字段 id。")
  } else {
    const dir = path.join(process.cwd(), ".tmp")
    fs.mkdirSync(dir, { recursive: true })
    const abs = path.join(dir, `t4-probe-${Date.now()}.png`)
    const rel = path.relative(process.cwd(), abs).split(path.sep).join("/")
    if (path.isAbsolute(rel) || rel.startsWith("..")) {
      throw new Error("upload_attachment --file 必须是当前目录下的相对路径")
    }
    fs.writeFileSync(abs, PNG)
    try {
      const uploaded = await call("upload_attachment", [
        "base",
        "+record-upload-attachment",
        ...common.slice(0, 4),
        "--record-id",
        recordId,
        "--field-id",
        fieldId(attachment),
        "--file",
        rel,
        ...common.slice(4),
      ])
      passAttach = uploaded.exitCode === 0 && !uploaded.json?.error
      console.log(`${passAttach ? "PASS" : "FAIL"} upload_attachment file=${rel} exit=${uploaded.exitCode}`)
    } finally {
      fs.rmSync(abs, { force: true })
    }
  }

  const searched = await call("count_marker", [
    "base",
    "+record-search",
    ...common.slice(0, 4),
    "--keyword",
    marker,
    "--search-field",
    textLabel,
    ...common.slice(4),
  ])
  const rows = recordCount(searched.json)
  console.log(`rows_with_marker=${rows ?? "(unparsed)"}`)
  const oneRow = rows === 1
  if (!oneRow) console.log("FAIL duplicate_check 期望标记只命中 1 行")
  else console.log("PASS duplicate_check")

  console.log("\nSUMMARY")
  console.log(`${pass1 ? "PASS" : "FAIL"} update_by_record_id`)
  console.log(`${passAttach ? "PASS" : "FAIL"} upload_attachment`)
  console.log(`${pass2 && oneRow ? "PASS" : "FAIL"} second_update_same_record_id`)
  console.log(`record_id=${recordId}`)
  if (!(pass1 && pass2 && passAttach && oneRow)) {
    throw new Error("probe steps failed")
  }
  } finally {
    for (const file of jsonFiles) fs.rmSync(file, { force: true })
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      if (message !== "probe steps failed" && message !== "create missing record_id") {
        console.error(`FAIL ${message}`)
      }
      process.exit(1)
    })
}
