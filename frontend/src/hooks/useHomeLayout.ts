import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { readCachedLayout, writeCachedLayout, removeCachedLayout } from '@/lib/homeLayoutCache'

export interface HomeWidget {
  toolId: string
  colSpan: 1 | 2
}

export interface HomeRow {
  id: string
  cols: HomeWidget[]
}

export type TickerSource = 'sports' | 'youtube' | 'news' | 'podcast' | 'calendar' | 'mail'

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

const ALL_TICKER_SOURCES: TickerSource[] = ['calendar', 'sports', 'youtube', 'news']

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
  /** Drop the saved layout so the server rebuilds the auto starter, then reload. */
  resetToAuto: () => Promise<void>
  reload: () => void
}

export function useHomeLayout(): UseHomeLayoutResult {
  const { user } = useAuth()
  const [layout, setLayout] = useState<HomeLayout>(() => (user?.id ? readCachedLayout(user.id) : undefined) ?? DEFAULT_LAYOUT)
  const [locked, setLocked] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [rev, setRev] = useState(0)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    // Paint the cached layout immediately (covers a profile switch after mount).
    if (user?.id) { const cached = readCachedLayout(user.id); if (cached) setLayout(cached) }
    fetch('/api/home-layout', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then((d: { layout?: HomeLayout; locked?: boolean } | null) => {
        if (cancelled) return
        if (d?.layout) { setLayout(d.layout); if (user?.id) writeCachedLayout(user.id, d.layout) }
        setLocked(d?.locked ?? false)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoading(false) })
    return () => { cancelled = true }
  }, [rev, user?.id])

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
    if (user?.id) writeCachedLayout(user.id, next)
  }, [user?.id])

  const reload = useCallback(() => setRev(v => v + 1), [])

  const resetToAuto = useCallback(async () => {
    const res = await fetch('/api/home-layout', { method: 'DELETE', credentials: 'include' })
    if (!res.ok) throw new Error(`Failed to reset layout (${res.status})`)
    // Drop the stale cache so the next paint uses the freshly-built auto starter.
    if (user?.id) removeCachedLayout(user.id)
    setRev(v => v + 1)
  }, [user?.id])

  return { layout, locked, isLoading, save, resetToAuto, reload }
}
