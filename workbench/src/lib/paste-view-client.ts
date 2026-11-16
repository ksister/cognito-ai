"use client"

import type { PasteView } from "./feishu"
import { cacheFallbackNotice, copySuccessNotice, type PasteColumnsSource } from "./paste-view"

/** Client-side shape of GET /api/feishu/paste-view. */
export type PasteViewApiState = {
  ok: true
  configured: boolean
  broken: boolean
  source: PasteColumnsSource | null
  viewName: string | null
  columns: string[]
  placeholders: string[]
  hidden: string[]
  readAt?: string
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

export type FetchedPasteView = {
  view: PasteView | null
  source: PasteColumnsSource | null
  /** 复制成功后的提示，已按列序来源说明该粘到哪个视图。 */
  notice: string
  /** 额外要提醒的：缓存兜底 / 读不到的原因。 */
  warning?: string
}

/**
 * The view to paste with (T16). Falls back to the cached column order when the
 * live read fails, and to the config order when there is no cache at all.
 */
export async function fetchPasteView(): Promise<FetchedPasteView> {
  const data = await fetchPasteViewApi()
  if (!data || !data.configured || data.source === "config" || !data.columns.length) {
    return {
      view: null,
      source: data?.source === "config" ? "config" : null,
      notice: copySuccessNotice("config", data?.viewName ?? null),
      warning: data?.error,
    }
  }

  const view: PasteView = {
    name: data.viewName ?? "已选视图",
    columns: data.columns.map((name) => ({ name })),
  }
  return {
    view,
    source: data.source,
    notice: copySuccessNotice(data.source, view.name),
    warning: data.source === "cache" ? cacheFallbackNotice(view.name, data.readAt ?? "") : undefined,
  }
}
