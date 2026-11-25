/**
 * T27：把两份转写（同一记录不同运行）按文字相似度对齐，找出「同一句话、发言人不同」的行。
 * 纯函数，页面和单测共用。
 *
 * 做法：
 *  1. 先用归一化后的文本做最长公共子序列对齐（快、稳）；
 *  2. 两个锚点之间剩下的行，按顺序配对，文本相似度够高（≥ 0.6）就算同一句（文字有出入也能对上）；
 *  3. 配上的行比较发言人，不同就标出来。
 *
 * Script-safe: no `server-only`, `.ts` suffix on relative runtime imports.
 */

export type AlignTurn = {
  speaker: string
  text: string
  kind?: "speech" | "time"
  side?: "left" | "right"
}

export type AlignedRow = {
  /** 当前这次运行的行；只在另一版里出现的行是 null。 */
  left: AlignTurn | null
  right: AlignTurn | null
  /** 两边都有这一句，但发言人不一样（时间分隔行不参与比较）。 */
  speakerDiff: boolean
  /** 两边都有这一句，但文字不完全一样（归一化后不同）。 */
  textDiff: boolean
}

/** 比较用的归一化：去掉空白、标点、符号，只留字和数字。 */
export function normalizeForAlign(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase()
}

function isTimeLine(turn: AlignTurn): boolean {
  return turn.kind === "time"
}

/** 发言人比较用的归一化（「我方同事」和具体名字不算同一个人，所以原样比）。 */
export function sameSpeaker(a: AlignTurn, b: AlignTurn): boolean {
  return String(a.speaker ?? "").trim() === String(b.speaker ?? "").trim()
}

/**
 * 文本相似度（0–1）：公共前后缀占比。
 * 只用来在「锚点之间」判断两行是不是同一句，够用且快。
 * 长度接近但内容完全不同的两行**不算**相似（不能靠长度蒙）。
 */
export function textSimilarity(a: string, b: string): number {
  const x = normalizeForAlign(a)
  const y = normalizeForAlign(b)
  if (!x && !y) return 1
  if (!x || !y) return 0
  if (x === y) return 1
  let prefix = 0
  const min = Math.min(x.length, y.length)
  while (prefix < min && x[prefix] === y[prefix]) prefix++
  let suffix = 0
  while (suffix < min - prefix && x[x.length - 1 - suffix] === y[y.length - 1 - suffix]) suffix++
  const common = prefix + suffix
  return (2 * common) / (x.length + y.length)
}

/** 最长公共子序列（按归一化文本相等），返回成对的锚点下标。 */
function lcsAnchors(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  if (!n || !m) return []
  // 只保留长度，回溯用不到表；为了省内存用两行滚动 + 记录方向。
  const dir: Uint8Array[] = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1))
  let prev = new Uint32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    const cur = new Uint32Array(m + 1)
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1
        dir[i][j] = 1 // 对角
      } else if (prev[j] >= cur[j - 1]) {
        cur[j] = prev[j]
        dir[i][j] = 2 // 上
      } else {
        cur[j] = cur[j - 1]
        dir[i][j] = 3 // 左
      }
    }
    prev = cur
  }
  const pairs: [number, number][] = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    const d = dir[i][j]
    if (d === 1) {
      pairs.push([i - 1, j - 1])
      i--
      j--
    } else if (d === 2) {
      i--
    } else {
      j--
    }
  }
  return pairs.reverse()
}

/**
 * 对齐两份转写。
 * `left` 是当前看的那次运行，`right` 是拿来对照的另一版。
 */
export function alignTranscripts(left: AlignTurn[], right: AlignTurn[]): AlignedRow[] {
  const leftKeys = left.map((t) => normalizeForAlign(t.text))
  const rightKeys = right.map((t) => normalizeForAlign(t.text))
  const anchors = lcsAnchors(leftKeys, rightKeys)

  const rows: AlignedRow[] = []
  let li = 0
  let ri = 0

  const flushGap = (leftEnd: number, rightEnd: number) => {
    // 锚点之间：按顺序配对；配不上时先看是不是某一边多了一行。
    const lGap = left.slice(li, leftEnd)
    const rGap = right.slice(ri, rightEnd)
    let k = 0
    let q = 0
    while (k < lGap.length && q < rGap.length) {
      const l = lGap[k]
      const r = rGap[q]
      if (textSimilarity(l.text, r.text) >= 0.6) {
        rows.push(makeRow(l, r))
        k++
        q++
        continue
      }
      const nextL = lGap[k + 1]
      const nextR = rGap[q + 1]
      if (nextL && textSimilarity(nextL.text, r.text) >= 0.6) {
        rows.push(makeRow(l, null))
        k++
        continue
      }
      if (nextR && textSimilarity(l.text, nextR.text) >= 0.6) {
        rows.push(makeRow(null, r))
        q++
        continue
      }
      // 两边都改了字但仍看得出是同一句（相似度 ≥0.3）：按顺序配，标 textDiff。
      // 完全不像的两行不硬配，各自单独成行。
      if (textSimilarity(l.text, r.text) >= 0.3) {
        rows.push(makeRow(l, r))
        k++
        q++
        continue
      }
      rows.push(makeRow(l, null))
      rows.push(makeRow(null, r))
      k++
      q++
    }
    while (k < lGap.length) rows.push(makeRow(lGap[k++], null))
    while (q < rGap.length) rows.push(makeRow(null, rGap[q++]))
    li = leftEnd
    ri = rightEnd
  }

  for (const [ai, bi] of anchors) {
    flushGap(ai, bi)
    rows.push(makeRow(left[ai], right[bi]))
    li = ai + 1
    ri = bi + 1
  }
  flushGap(left.length, right.length)
  return rows
}

function makeRow(left: AlignTurn | null, right: AlignTurn | null): AlignedRow {
  const textDiff = Boolean(
    left && right && normalizeForAlign(left.text) !== normalizeForAlign(right.text),
  )
  const speakerDiff = Boolean(
    left && right && !isTimeLine(left) && !isTimeLine(right) && !sameSpeaker(left, right),
  )
  return { left, right, speakerDiff, textDiff }
}

/** 统计「发言人不同」的行数（页面汇总用）。 */
export function countSpeakerDiffs(rows: AlignedRow[]): number {
  return rows.filter((r) => r.speakerDiff).length
}
