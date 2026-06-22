// DeArrow client: a tiny app-wide provider that swaps video titles/thumbnails for the
// community-voted alternatives. Cards across the app call useDeArrow(videoId); requests
// are coalesced into one batched round-trip (80ms debounce) and cached, so a feed of
// 100 cards is a single POST. A global toggle (default on) flips it off without code.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { getDeArrowBatch, type DeArrowItem } from '@/lib/youtube/api'

const KEY = 'yt.dearrow'

// Provider-independent access to the global DeArrow on/off flag (default on). The
// Settings → YouTube tab lives outside the YouTube layout (so outside DeArrowProvider),
// so it reads/writes the flag directly here; the provider re-reads it on its next mount.
export function readDeArrowEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== '0' } catch { return true }
}
export function writeDeArrowEnabled(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch { /* quota */ }
}

interface DeArrowCtx {
  enabled: boolean
  toggle: () => void
  request: (videoId: string) => void
  get: (videoId: string) => DeArrowItem | undefined
}
const Ctx = createContext<DeArrowCtx | null>(null)

export function DeArrowProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(readDeArrowEnabled)   // default on
  const [cache, setCache] = useState<Record<string, DeArrowItem>>({})
  const cacheRef = useRef(cache); cacheRef.current = cache
  const pending = useRef(new Set<string>())
  const inflight = useRef(new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(async () => {
    timer.current = null
    const ids = [...pending.current].filter(id => !(id in cacheRef.current) && !inflight.current.has(id))
    pending.current.clear()
    if (!ids.length) return
    ids.forEach(id => inflight.current.add(id))
    try {
      const res = await getDeArrowBatch(ids)
      // Cache an entry for every requested id (even empty) so we never re-request it.
      const merged: Record<string, DeArrowItem> = {}
      for (const id of ids) merged[id] = res[id] ?? { title: null, thumbnailUrl: null }
      setCache(prev => ({ ...prev, ...merged }))
    } catch { /* best-effort */ } finally {
      ids.forEach(id => inflight.current.delete(id))
    }
  }, [])

  const request = useCallback((videoId: string) => {
    if (!videoId || videoId in cacheRef.current || inflight.current.has(videoId)) return
    pending.current.add(videoId)
    if (timer.current == null) timer.current = setTimeout(flush, 80)
  }, [flush])

  const toggle = useCallback(() => {
    setEnabled(e => { const n = !e; writeDeArrowEnabled(n); return n })
  }, [])

  const get = useCallback((videoId: string) => cache[videoId], [cache])

  return <Ctx.Provider value={{ enabled, toggle, request, get }}>{children}</Ctx.Provider>
}

/** Branding for one video, or undefined when DeArrow is off / not loaded / has no entry. */
export function useDeArrow(videoId: string | undefined): DeArrowItem | undefined {
  const ctx = useContext(Ctx)
  const on = ctx?.enabled && !!videoId
  useEffect(() => { if (on && ctx && videoId) ctx.request(videoId) }, [on, ctx, videoId])
  return on && ctx && videoId ? ctx.get(videoId) : undefined
}

/** The global on/off switch (for the toggle control). Safe outside the provider. */
export function useDeArrowToggle(): { enabled: boolean; toggle: () => void } {
  const ctx = useContext(Ctx)
  return { enabled: ctx?.enabled ?? false, toggle: ctx?.toggle ?? (() => {}) }
}
