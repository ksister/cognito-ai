#!/usr/bin/env node
/**
 * T27：用当前的发言人规则（speaker-resolve）重判回放结果里已经存好的 turns，
 * **不重新调用模型**（turns 里有 rawSpeaker + side）。
 *
 * 用法：
 *   node scripts/rejudge-replay.mjs --records R153,R154,R002      # 默认 dry-run，只报告
 *   node scripts/rejudge-replay.mjs --records ... --apply         # 真正写回结果文件
 *   node scripts/rejudge-replay.mjs --all [--apply]               # 全部有 turns 的结果
 *
 * 只改 replay/results 里的派生数据：turns[].speaker、transcript、uncertain（发言人相关的提示）。
 * 不碰 records/、不碰快照、不连飞书。写回前逐条打印新旧计数，--apply 也可以先 dry-run 看一眼。
 */
import fs from "node:fs"
import path from "node:path"
import { namesFromWindowTitle, resolveSpeakerTurns } from "../src/lib/speaker-resolve.ts"
import { formatScreenshotChat } from "../src/lib/transcript.ts"
import { writeJsonAtomic } from "../src/lib/replay-store.ts"

function readEnv(file = ".env.local") {
  const env = {}
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    env[m[1]] = v
  }
  return env
}

const SPEAKER_NOTE = /气泡在左|气泡在右|读不出气泡|我方公司前缀|既没有昵称|按昵称认成/

function countSpeakers(turns) {
  const c = { me: 0, colleague: 0, customer: 0, unknown: 0 }
  for (const t of turns ?? []) {
    if (t.kind === "time") continue
    const who = String(t.speaker ?? "").trim()
    if (who === "我") c.me++
    else if (who === "我方同事") c.colleague++
    else if (who === "未知") c.unknown++
    else c.customer++
  }
  return c
}

const args = process.argv.slice(2)
const apply = args.includes("--apply")
const all = args.includes("--all")
const recIdx = args.indexOf("--records")
const only = recIdx >= 0 ? String(args[recIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean) : []
const kbIdx = args.indexOf("--kb")

const env = readEnv()
// --kb 可以指向一个临时目录（拿副本做 dry-run / 验证），默认用 .env.local 里的 KB_DIR。
const kb = kbIdx >= 0 ? path.resolve(String(args[kbIdx + 1] ?? "")) : env.KB_DIR
if (!kb) throw new Error("缺少 KB_DIR（只写在 .env.local）")
const settingsRaw = JSON.parse(fs.readFileSync(path.join(kb, "config", "speakers.json"), "utf8"))
const settings = {
  myNicknames: Array.isArray(settingsRaw.myNicknames) ? settingsRaw.myNicknames : [],
  companyPrefixes: Array.isArray(settingsRaw.companyPrefixes) ? settingsRaw.companyPrefixes : [],
}
const resultsRoot = path.join(kb, "replay", "results")
const snapshotRoot = path.join(kb, "replay", "snapshot")

/**
 * 这次运行的聊天窗口标题：优先用结果文件里存的 windowTitle；
 * 老结果没存，就退回快照里同一张截图的转写缓存（那里有 windowTitle），取第一个非空的。
 */
function windowTitleFor(run) {
  if (run.windowTitle) return run.windowTitle
  try {
    const detailPath = path.join(snapshotRoot, "records", `${run.r}.json`)
    const detail = JSON.parse(fs.readFileSync(detailPath, "utf8"))
    for (const shot of detail.shots ?? []) {
      if (!shot?.transcript) continue
      try {
        const t = JSON.parse(fs.readFileSync(path.join(snapshotRoot, shot.transcript), "utf8"))
        if (typeof t.windowTitle === "string" && t.windowTitle) return t.windowTitle
      } catch {}
    }
  } catch {}
  return ""
}

let scanned = 0
let changed = 0
let skipped = 0
let quoteTotal = 0
let replyTotal = 0
let unsplitTotal = 0

for (const dirName of fs.readdirSync(resultsRoot)) {
  const dir = path.join(resultsRoot, dirName)
  if (!fs.statSync(dir).isDirectory()) continue
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    const file = path.join(dir, name)
    const run = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!Array.isArray(run.turns) || !run.turns.length) continue
    if (only.length && !only.includes(run.r)) continue
    if (!only.length && !all) continue
    scanned++
    // 用模型看到的原始名字 + 侧别重判；没有 rawSpeaker 的旧结果跳过（重判不了）
    if (!run.turns.every((t) => typeof t.rawSpeaker === "string")) {
      skipped++
      console.log(`${run.r} ${run.runId}: 没有 rawSpeaker，跳过`)
      continue
    }
    const before = countSpeakers(run.turns)
    const input = run.turns.map((t) => ({
      speaker: t.rawSpeaker,
      text: t.text,
      kind: t.kind === "time" ? "time" : "speech",
      ...(t.side ? { side: t.side } : {}),
    }))
    const titleNames = namesFromWindowTitle(windowTitleFor(run))
    const { turns: resolved, uncertain: speakerNotes, quotes, quotesByName, quotesByDup, repliesSplit, repliesUnsplit } =
      resolveSpeakerTurns(input, settings, titleNames)
    const after = countSpeakers(resolved)
    const same =
      before.me === after.me &&
      before.colleague === after.colleague &&
      before.customer === after.customer &&
      before.unknown === after.unknown
    if (!same) changed++
    if (quotes) quoteTotal += quotes
    replyTotal += repliesSplit
    unsplitTotal += repliesUnsplit
    console.log(
      `${run.r} ${run.transcriptPromptVersion ?? "-"} ${run.runId}: ` +
        `我 ${before.me}→${after.me} 同事 ${before.colleague}→${after.colleague} ` +
        `客户 ${before.customer}→${after.customer} 未知 ${before.unknown}→${after.unknown}` +
        ` 引用 ${quotes}（名字:内容 ${quotesByName} / 重复 ${quotesByDup} / 飞书回复 ${repliesSplit}` +
        `${repliesUnsplit ? ` / 拆不出 ${repliesUnsplit}` : ""}）` +
        `${same ? "" : " *"}`,
    )
    if (!apply) continue
    const kept = (run.uncertain ?? []).filter((n) => !SPEAKER_NOTE.test(String(n)))
    const nextUncertain = [...kept, ...speakerNotes]
    // 引用行会并进上一条，行数可能变少：按重判后的 turns 重建，rawSpeaker 用重判时记下的原始名字。
    run.turns = resolved.map((t) => ({
      speaker: t.speaker,
      rawSpeaker: t.rawSpeaker ?? "",
      text: t.text,
      kind: t.kind === "time" ? "time" : "speech",
      ...(t.side ? { side: t.side } : {}),
      ...(t.quote ? { quote: t.quote } : {}),
    }))
    run.transcript = formatScreenshotChat(resolved)
    run.uncertain = nextUncertain
    writeJsonAtomic(file, run)
  }
}

console.log(
  `\n共扫描 ${scanned} 次运行；计数有变化 ${changed} 次；跳过 ${skipped} 次；` +
    `并入上一条的引用 ${quoteTotal} 行；飞书回复拆出引用 ${replyTotal} 行（拆不出 ${unsplitTotal} 行）。` +
    (apply ? "已写回。" : "（dry-run，没有写文件；加 --apply 才写）"),
)
