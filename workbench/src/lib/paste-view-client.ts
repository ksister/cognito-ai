"use client"

import type { PasteView } from "./feishu"

/** Client-side shape of GET /api/feishu/paste-view. */
export type PasteViewApiState = {
  ok: true
  configured: boolean
  readable: boolean
  viewName: string | null
  columns: string[]
  placeholders: string[]
  hidden: string[]
  error?: string
}

export async function fetchPasteViewApi(): Promise<PasteViewApiState | null> {
  try {
    const res = await fetch("/api/feishu/paste-view")
    if (!res.ok) return null
    const data = (await res.json()) as PasteViewApiState
    return data?.ok ? data : null
  } catch {
    return null
  }
}

/**
 * The view to paste with, plus a hint when it could not be read (T16 fallback:
 * copy in the configured column order instead and tell the user).
 */
export async function fetchPasteView(): Promise<{ view: PasteView | null; warning?: string }> {
  const data = await fetchPasteViewApi()
  if (!data || !data.configured) return { view: null }
  if (!data.readable || !data.columns.length) {
    return {
      view: null,
      warning: `读不到视图「${data.viewName ?? ""}」，已按 feishu-table.json 的列顺序复制${
        data.error ? `：${data.error}` : ""
      }`,
    }
  }
  return { view: { name: data.viewName ?? "已选视图", columns: data.columns.map((name) => ({ name })) } }
}
