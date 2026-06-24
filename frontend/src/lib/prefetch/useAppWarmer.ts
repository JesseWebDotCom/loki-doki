// Idle warmer: after the app is up and the browser goes idle, pre-warm the React Query
// cache (and a few thumbnails) for the user's pinned apps — then their most-recent ones —
// so opening them is instant instead of showing a spinner. Mounted once, in AppShell.
//
// Targets come from a single shared, cached read of the user's preferences (pinned/recent
// + saved location), so we don't double-fetch what the sidebar already loaded. Warming is
// bounded-concurrency and skips the app the user is already on (it's loading itself).

import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'
import { useConnectivity } from '@/hooks/useConnectivity'
import { getAppByPath } from '@/lib/appCategories'
import { APP_PREFETCHERS, type WarmCtx } from './registry'
import { useWarmPrefs } from './useWarmContext'

const CONCURRENCY = 2

type IdleHandle = number
function onIdle(cb: () => void): () => void {
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => IdleHandle
    cancelIdleCallback?: (id: IdleHandle) => void
  }
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(cb, { timeout: 3000 })
    return () => w.cancelIdleCallback?.(id)
  }
  const t = setTimeout(cb, 1500)
  return () => clearTimeout(t)
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await fn(item).catch(() => {}) // a failed warm must never break the others
    }
  })
  await Promise.all(workers)
}

export function useAppWarmer(): void {
  const qc = useQueryClient()
  const { pathname } = useLocation()
  const connectivity = useConnectivity()
  const { data: prefs } = useWarmPrefs()

  const online = connectivity?.appMode === 'standard' && (connectivity?.hasNetwork ?? false)
  const offline = connectivity != null && !connectivity.hasNetwork
  const saveData =
    typeof navigator !== 'undefined' &&
    (navigator as unknown as { connection?: { saveData?: boolean } }).connection?.saveData === true

  const pinned = prefs?.pinned
  const recent = prefs?.recent
  const location = prefs?.location ?? null

  useEffect(() => {
    if (!pinned) return // preferences not loaded yet
    if (saveData || offline) return // respect data-saver and don't spam requests while offline

    const currentApp = getAppByPath(pathname)?.id
    const order: string[] = []
    const consider = (id: string) => {
      if (id && id !== currentApp && id in APP_PREFETCHERS && !order.includes(id)) order.push(id)
    }
    for (const id of pinned) consider(id)
    for (const id of (recent ?? []).slice(0, 3)) consider(id)
    if (!order.length) return

    let cancelled = false
    const ctx: WarmCtx = { online, location }
    const cancelIdle = onIdle(() => {
      if (cancelled) return
      void runWithConcurrency(order, CONCURRENCY, async (id) => {
        if (cancelled) return
        await APP_PREFETCHERS[id]?.(qc, ctx)
      })
    })
    return () => {
      cancelled = true
      cancelIdle()
    }
  }, [pinned, recent, pathname, online, offline, location, saveData, qc])
}
