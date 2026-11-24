#!/usr/bin/env node
/**
 * T26 回放测试快照（只读飞书正式表 → 生成/刷新 KB_DIR/replay/snapshot/）
 *
 * 只读：只调用 lark-cli 的读接口（+field-list、+record-list、+record-download-attachment），
 * 不往飞书写任何东西。预览默认什么文件都不写；带 --yes 才写快照。
 *
 * 实现只有一份：src/lib/replay-snapshot.ts（页面 API /api/replay/snapshot 也调它）。
 *
 * 用法（在 workbench/ 目录下，Node >= 22.18；相对导入要带 .ts 后缀）：
 *   node scripts/replay-snapshot.mjs plan    [--work <dir>] [--json]
 *   node scripts/replay-snapshot.mjs apply   --yes [--work <dir>]
 *
 * 环境变量（只写在 .env.local）：KB_DIR、LARK_BASE_TOKEN、LARK_PROD_TABLE_ID、
 * LARK_CLI_PATH（可选）、DASHSCOPE_API_KEY、DASHSCOPE_BASE_URL、DASHSCOPE_VL_MODEL
 *
 * 产物：KB_DIR/replay/snapshot/{manifest.json, records/, media/, transcripts/, _incoming/}
 *
 * 隐私：脚本只打印数量、布尔值和费用，不打印客户名和飞书记录 ID。
 */
import path from "node:path"
import { loadDotEnv } from "../src/lib/dotenv.ts"
import { planReplaySnapshot, applyReplaySnapshot, replayConfigFromEnv } from "../src/lib/replay-snapshot.ts"
import { planReportLines } from "../src/lib/replay-model.ts"

const SCRIPT_DIR = import.meta.dirname

const USAGE = `T26 回放测试快照（只读飞书）
  node scripts/replay-snapshot.mjs plan    [--work <dir>] [--json]   预览：要读多少、新增多少、复制多少文件多大、费用耗时
  node scripts/replay-snapshot.mjs apply   --yes [--work <dir>]      执行：下载/复制/转写，写 KB_DIR/replay/snapshot/`

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

function loadEnv() {
  loadDotEnv(path.resolve(SCRIPT_DIR, "..", ".env.local"))
  loadDotEnv(path.resolve(process.cwd(), ".env.local"))
}

async function main() {
  loadEnv()
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0] || "help"
  if (cmd === "help" || args.help) {
    console.log(USAGE)
    return
  }
  const cfgState = replayConfigFromEnv(process.env, { workDir: args.work ? path.resolve(String(args.work)) : undefined })
  if (!cfgState.ok) throw new Error(cfgState.error)
  const cfg = cfgState.cfg

  if (cmd === "plan") {
    const plan = await planReplaySnapshot(cfg)
    if (args.json) {
      console.log(JSON.stringify(plan.numbers, null, 2))
      return
    }
    console.log("=== 刷新快照预览（只读，未写任何文件） ===")
    for (const line of planReportLines(plan.numbers)) console.log(line)
    console.log("")
    console.log("确认后执行：node scripts/replay-snapshot.mjs apply --yes")
    return
  }

  if (cmd === "apply") {
    if (args.yes !== true) throw new Error("apply 会写 KB_DIR，必须显式带 --yes（先跑 plan 看预览）")
    const t0 = Date.now()
    const result = await applyReplaySnapshot(cfg, {
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) console.log(`  处理进度 ${done}/${total}`)
      },
    })
    console.log("=== 快照已刷新 ===")
    for (const line of planReportLines(result.plan)) console.log(line)
    console.log("")
    console.log(`记录：${result.records} 条（新写入 ${result.written}，未变 ${result.unchanged}），截图 ${result.shots} 张`)
    console.log(`复制进快照：截图 ${result.mediaCopied} 个（${Math.round(result.mediaBytes / 1024)} KB），转写 ${result.transcriptsCopied} 份`)
    console.log(`本次转写：${result.transcribed} 张；失败：${result.failures} 条`)
    console.log(
      result.fingerprintAfter
        ? `只读复核：刷新后指纹 ${result.fingerprintAfter}，${result.fingerprintAfter === result.plan.fingerprint ? "与刷新前一致（飞书未被修改）" : "与刷新前不一致，请人工核对"}`
        : "只读复核：没能再读一次飞书，未做指纹对比",
    )
    console.log(`用时：${Math.round((Date.now() - t0) / 1000)} 秒`)
    if (result.failures) console.log("失败明细（R 编号 + 原因）见 KB_DIR/replay/snapshot/last-apply.json")
    return
  }

  throw new Error(`未知命令：${cmd}\n${USAGE}`)
}

if (import.meta.filename === path.resolve(process.argv[1] || "")) {
  main().catch((e) => {
    console.error(`错误：${e?.message || e}`)
    process.exitCode = 1
  })
}
