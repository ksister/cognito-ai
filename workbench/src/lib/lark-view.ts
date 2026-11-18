import "server-only"
import { resolveLarkCli, runLarkCli } from "./lark-bitable"
import { viewColumnNames, type ViewColumn } from "./paste-view"

/**
 * Read-only lark-cli calls used by T16. Never writes to Feishu.
 * Only view names, column names and counts leave this module — no ids, no tokens.
 */

type Target = { baseToken: string; tableId: string }

function readTarget(): Target | { error: string } {
  const baseToken = process.env.LARK_BASE_TOKEN?.trim() ?? ""
  const tableId = process.env.LARK_TABLE_ID?.trim() ?? ""
  if (!baseToken || !tableId) {
    return { error: "未配置 LARK_BASE_TOKEN 或 LARK_TABLE_ID，无法读取视图" }
  }
  return { baseToken, tableId }
}

type CliEnvelope = { ok?: boolean; data?: unknown; error?: unknown; msg?: unknown }

/** Never surface table/view ids or log ids to the browser (D9 / 坑 11). */
function sanitize(text: string): string {
  return text
    .replace(/\bvew[A-Za-z0-9]{4,}/g, "视图")
    .replace(/\b(?:tbl|fld|rec|bas|box)[A-Za-z0-9]{6,}/g, "…")
    .replace(/\s+/g, " ")
    .trim()
}

function cliFailure(json: Record<string, unknown> | null, stderr: string): string {
  const env = json as CliEnvelope | null
  const raw = env?.error ?? env?.msg
  if (raw) {
    const text =
      typeof raw === "string"
        ? raw
        : typeof (raw as { message?: unknown }).message === "string"
          ? String((raw as { message: string }).message)
          : JSON.stringify(raw)
    if (/token|auth|login|expired|401/i.test(text)) {
      return `飞书登录可能过期：${sanitize(text)}。请重新执行 lark-cli auth login --domain base,drive --scope offline_access`
    }
    return sanitize(text)
  }
  return sanitize(stderr.trim()) || "lark-cli 没有返回可解析的结果"
}

export type FeishuViewSummary = { id: string; name: string; columnCount: number | null }

/** View names only — the id never leaves the server. */
export async function listFeishuViews(): Promise<
  { ok: true; views: FeishuViewSummary[] } | { ok: false; error: string }
> {
  const target = readTarget()
  if ("error" in target) return { ok: false, error: target.error }
  const resolved = await resolveLarkCli()
  if (!resolved.path) return { ok: false, error: resolved.error ?? "未找到 lark-cli" }

  const run = await runLarkCli(resolved.path, [
    "base",
    "+view-list",
    "--base-token",
    target.baseToken,
    "--table-id",
    target.tableId,
    "--as",
    "user",
    "--format",
    "json",
  ])
  const data = (run.json?.data ?? {}) as { views?: unknown }
  const raw = Array.isArray(data.views) ? (data.views as Record<string, unknown>[]) : null
  if (!raw) return { ok: false, error: cliFailure(run.json, run.stderr) }

  const views = raw
    .map((v) => {
      const name = String(v.name ?? "").trim()
      const id = String(v.id ?? "").trim()
      const meta = (v._meta ?? {}) as { visible_fields?: unknown }
      const countText = typeof meta.visible_fields === "string" ? meta.visible_fields : ""
      const digit = countText.match(/\d+/)?.[0]
      return { id, name, columnCount: digit ? Number(digit) : null }
    })
    .filter((v) => v.name)

  return { ok: true, views }
}

/** Visible columns of one view, in the order lark-cli reports them. */
export async function readFeishuViewColumns(
  viewIdOrName: string,
): Promise<{ ok: true; name: string; columns: ViewColumn[] } | { ok: false; error: string }> {
  const target = readTarget()
  if ("error" in target) return { ok: false, error: target.error }
  const resolved = await resolveLarkCli()
  if (!resolved.path) return { ok: false, error: resolved.error ?? "未找到 lark-cli" }

  const run = await runLarkCli(resolved.path, [
    "base",
    "+view-get-visible-fields",
    "--base-token",
    target.baseToken,
    "--table-id",
    target.tableId,
    "--view-id",
    viewIdOrName,
    "--as",
    "user",
    "--format",
    "json",
  ])
  const data = (run.json?.data ?? {}) as { visible_fields?: unknown }
  if (!Array.isArray(data.visible_fields)) {
    return { ok: false, error: cliFailure(run.json, run.stderr) }
  }
  const columns = viewColumnNames((data.visible_fields as unknown[]).map((x) => String(x)))
    .filter(Boolean)
    .map((name) => ({ name }))
  if (!columns.length) return { ok: false, error: "这个视图没有可见列" }
  return { ok: true, name: viewIdOrName, columns }
}
