// App-wide lazy-image warmer: warm every deferred <img> on the page, whatever rendered it.
//
// useScrollAheadImages only covers surfaces that opt in by handing it their item list, and
// the app has dozens of hand-rolled `<img loading="lazy">` that never will - the Home
// page's rails alone have ten, plus news, music art, podcast covers, briefing tiles. Each
// one showed a grey box and started its request the moment it scrolled into view.
//
// The trick that makes this general: a lazy <img> ALREADY carries its final URL in `src`.
// The browser has parsed it and simply deferred the fetch. So sweeping the DOM yields the
// exact URLs, in document order (which is scroll order), for every surface at once, with
// no per-component wiring and no risk of warming a URL that differs from what renders.
//
// Warms go through the same bounded queue as everything else (3 in flight, low priority),
// so this never floods the handful of HTTP/1.1 connections the phone has to the hub.

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { preloadImages, cancelImagePreloads, shouldWarmImages } from './preloadImages'
import { onIdle } from './onIdle'

/** Ceiling per sweep. Already-warmed URLs are deduped, so this bounds new work only. */
const MAX_PER_SWEEP = 200
/** Minimum gap between sweeps. This is a THROTTLE, not a debounce: the Home page runs a
 *  continuously animating ticker, and a debounce would be reset by it on every frame and
 *  never fire at all. Throttling sweeps on a fixed cadence regardless of how busy the DOM is. */
const THROTTLE_MS = 500

const GROUP = Symbol('lazy-img-warmer')

function collectDeferred(): string[] {
  const urls: string[] = []
  for (const img of document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]')) {
    // `complete` is true once the browser has the bytes (and for a src-less img), so this
    // leaves only the ones still waiting on a scroll.
    if (img.complete) continue
    const src = img.currentSrc || img.src
    // blob:/data: srcs (e.g. the IndexedDB image store's object URLs) load from memory;
    // there is nothing to warm.
    if (src && !src.startsWith('blob:') && !src.startsWith('data:')) urls.push(src)
  }
  return urls
}

export function useLazyImageWarmer(): void {
  const { pathname } = useLocation()

  useEffect(() => {
    if (!shouldWarmImages()) return

    let timer: ReturnType<typeof setTimeout> | null = null
    let cancelIdle: (() => void) | null = null
    let pending = false

    const sweep = () => {
      timer = null
      // A hidden tab is not about to be scrolled; warming it just burns the connection
      // pool the visible tab (or a download) could be using. Leave `pending` set so the
      // next visibilitychange sweeps instead of dropping the request.
      if (document.visibilityState === 'hidden') return
      pending = false
      cancelIdle = onIdle(() => preloadImages(collectDeferred(), MAX_PER_SWEEP, GROUP))
    }

    const schedule = () => {
      pending = true
      if (timer) return // a sweep is already booked; do not push it back
      timer = setTimeout(sweep, THROTTLE_MS)
    }

    // First pass after the route's initial paint, then on a fixed cadence while the DOM
    // grows: shelves resolving one query at a time, tab switches, infinite-scroll appends.
    schedule()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    const onVisible = () => { if (pending || document.visibilityState === 'visible') schedule() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', onVisible)
      if (timer) clearTimeout(timer)
      cancelIdle?.()
      cancelImagePreloads(GROUP)
    }
  }, [pathname])
}
