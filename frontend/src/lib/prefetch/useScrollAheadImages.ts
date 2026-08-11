// Warm a list's images ahead of the scroll, for the list you are ON.
//
// The app's other warmer (useAppWarmer) warms apps you are NOT on, page 1 only. Once a
// feed is rendered, nothing warmed anything: every card past the first screenful is
// `loading="lazy"`, so the browser issued its request at the moment the card appeared -
// on a phone, visibly. This hook closes that gap: give it the ordered image URLs of the
// currently-loaded list and it drips them into the HTTP cache in list order, at low
// priority and bounded concurrency, starting once the browser is idle after first paint.
//
// Feed each new infinite-scroll page's URLs in too (just pass the full accumulated list -
// already-warmed URLs are deduped), so page 2+ is warm before you reach it as well.
//
// CONTRACT: the URLs passed here must be byte-identical to what the cards render, proxy
// and width included. Warming `/api/img?u=X` when the card renders `/api/img?u=X&w=640`
// warms nothing. Build them with the same helper the card uses (proxyImg/avatarImgUrl).

import { useEffect, useRef } from 'react'
import { preloadImages, cancelImagePreloads } from './preloadImages'
import { onIdle } from './onIdle'

/** Ceiling per list. Deep infinite-scroll sessions shouldn't warm a thousand images. */
const DEFAULT_MAX = 160

export function useScrollAheadImages(
  urls: (string | null | undefined)[],
  opts?: { max?: number; enabled?: boolean },
): void {
  const max = opts?.max ?? DEFAULT_MAX
  const enabled = opts?.enabled ?? true
  // One group per mounted list, so navigating away drops whatever is still queued.
  const group = useRef<symbol>(undefined as unknown as symbol)
  if (!group.current) group.current = Symbol('scroll-ahead')

  // Cheap change key: the list only ever grows (infinite scroll) or is replaced wholesale
  // (filter/tab change). Re-running with an unchanged list is a no-op anyway - preloadImages
  // dedupes every URL it has already kicked off.
  const first = urls[0] ?? ''
  const last = urls[urls.length - 1] ?? ''
  const len = urls.length

  useEffect(() => {
    if (!enabled || !len) return
    // Respect data-saver, and don't queue fetches that can only fail while offline.
    const saveData = (navigator as unknown as { connection?: { saveData?: boolean } }).connection?.saveData === true
    if (saveData || navigator.onLine === false) return

    const g = group.current
    const cancelIdle = onIdle(() => preloadImages(urls, max, g))
    return () => {
      cancelIdle()
      cancelImagePreloads(g)
    }
    // `urls` itself is a new array every render; the key below is what actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, len, first, last, max])
}
