import { useCallback, useEffect, useState } from 'react'

export interface HomeWidget {
  toolId: string
  colSpan: 1 | 2
}

export interface HomeRow {
  id: string
  cols: HomeWidget[]
}

export type TickerSource = 'sports' | 'youtube' | 'news' | 'podcast'

export interface TickerConfig {
  enabled: boolean
  sources: TickerSource[]
}

export interface HomeLayoutHeader {
  weather: boolean
  jokes: boolean
  ticker: TickerConfig
  locked: boolean
}

export interface HomeLayout {
  header: HomeLayoutHeader
  canvas: HomeRow[]
}

const ALL_TICKER_SOURCES: TickerSource[] = ['sports', 'youtube', 'news']

/** Handles old stored layouts that have `header.sports: boolean` instead of `header.ticker`. */
export function resolveTickerConfig(header: HomeLayoutHeader): TickerConfig {
  if (header.ticker) return header.ticker
  const legacySports = (header as unknown as { sports?: boolean }).sports
  return { enabled: legacySports !== false, sources: legacySports !== false ? ALL_TICKER_SOURCES : [] }
}

// Fallback shown only until /api/home-layout responds. Mirrors the backend's
// default so a fresh user never flashes an empty home; the server's resolved
// layout (system default or the user's own) replaces this on load.
const DEFAULT_LAYOUT: HomeLayout = {
  header: { weather: true, jokes: true, ticker: { enabled: true, sources: ALL_TICKER_SOURCES }, locked: false },
  canvas: [
    { id: 'default-news', cols: [{ toolId: 'news', colSpan: 2 }] },
    { id: 'default-on-this-day', cols: [{ toolId: 'on-this-day', colSpan: 2 }] },
  ],
}

export interface UseHomeLayoutResult {
  layout: HomeLayout
  locked: boolean
  isLoading: boolean
  save: (layout: HomeLayout) => Promise<void>
  reload: () => void
}

export function useHomeLayout(): UseHomeLayoutResult {
  const [layout, setLayout] = useState<HomeLayout>(DEFAULT_LAYOUT)
  const [locked, setLocked] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [rev, setRev] = useState(0)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    fetch('/api/home-layout', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { layout?: HomeLayout; locked?: boolean } | null) => {
        if (cancelled) return
        if (d?.layout) setLayout(d.layout)
        setLocked(d?.locked ?? false)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoading(false) })
    return () => { cancelled = true }
  }, [rev])

  const save = useCallback(async (next: HomeLayout) => {
    // Check res.ok: fetch only rejects on network errors, so a 401 (expired session), 403
    // (admin-locked layout), or 500 would otherwise resolve normally and we'd show the new
    // layout as saved even though the server rejected it (silently reverting on next reload).
    const res = await fetch('/api/home-layout', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    })
    if (!res.ok) throw new Error(`Failed to save layout (${res.status})`)
    setLayout(next)
  }, [])

  const reload = useCallback(() => setRev(v => v + 1), [])

  return { layout, locked, isLoading, save, reload }
}
