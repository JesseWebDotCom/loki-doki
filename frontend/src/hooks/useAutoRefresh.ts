import { useSyncExternalStore } from 'react'

// One shared "refresh epoch" for the whole app. It bumps whenever periodic
// home-page data should revalidate WITHOUT a hard refresh:
//   • the tab becomes visible again after being hidden (the "I opened this two
//     days ago" case — this is the important one),
//   • the window regains focus,
//   • the network comes back online,
//   • the wall-clock day rolls over (so the date line + greeting update), and
//   • a slow background interval elapses while the tab stays open and visible.
//
// Widgets add the returned number to their fetch-effect deps to re-run the
// fetch; the data layer's own short-TTL caches (e.g. the 5-min weather cache)
// keep a bump cheap — a real network hit only happens once the cache is stale.
//
// This is a single module-level store shared by every subscriber, so the whole
// app registers exactly one set of listeners and one interval, not one per
// widget. useSyncExternalStore keeps every consumer in lockstep on the epoch.

const INTERVAL_MS = 5 * 60 * 1000

let epoch = 0
const listeners = new Set<() => void>()
let started = false
let lastDayKey = ''

function currentDayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function bump() {
  epoch += 1
  for (const l of listeners) l()
}

function ensureStarted() {
  if (started || typeof window === 'undefined') return
  started = true
  lastDayKey = currentDayKey()

  const onVisible = () => {
    if (document.visibilityState === 'visible') bump()
  }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', bump)
  window.addEventListener('online', bump)

  // Slow heartbeat: refresh a tab left open and staring at the dashboard, and
  // catch the midnight day-rollover even when the tab is never blurred so the
  // greeting flips ("Good morning" → "Good evening") on its own.
  setInterval(() => {
    if (document.visibilityState !== 'visible') return
    lastDayKey = currentDayKey()
    bump()
  }, INTERVAL_MS)
}

function subscribe(cb: () => void): () => void {
  ensureStarted()
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/**
 * Returns a number that increments whenever long-idle home-page data should be
 * re-fetched. Add it to a fetch effect's dependency array to revalidate on tab
 * re-show / focus / reconnect / day-change without a hard page refresh.
 */
export function useAutoRefresh(): number {
  return useSyncExternalStore(subscribe, () => epoch, () => epoch)
}
