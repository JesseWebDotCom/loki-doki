// Image warming: kick off the browser's image fetch+decode for thumbnails BEFORE they
// scroll into view, so a card paints from the HTTP cache instead of starting a request
// the moment it appears. Every card image in the app is `loading="lazy"` past the first
// screenful, which is exactly the behaviour that made feeds feel like they load "just in
// time" - this is the counterweight.
//
// Two things make this safe to point at a whole feed rather than a handful of URLs:
//   • Bounded concurrency. The hub speaks HTTP/1.1, so a phone has ~6 connections to it.
//     Firing 60 `new Image()` at once would queue every warm AHEAD of the images the user
//     is actually looking at. We keep at most CONCURRENCY warms in flight.
//   • fetchPriority: 'low'. Where supported, the browser schedules warms behind real
//     in-viewport loads on top of that.
//
// Idempotent: the browser dedupes by URL, and `seen` keeps us from re-queuing a URL we
// already kicked off this session. Callers can pass the same list every render.

import { hasStoredImage } from '@/lib/imageStore'

const CONCURRENCY = 3

const seen = new Set<string>()
type Entry = { url: string; group: symbol | null }
const queue: Entry[] = []
let inFlight = 0

/** Whether speculative image warming is worth the bandwidth right now. Data-saver and
 *  2g-class links say no: there, every connection belongs to what is actually on screen.
 *  (iOS has no Network Information API, so effectiveType only helps Android/desktop.) */
export function shouldWarmImages(): boolean {
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (conn?.saveData === true) return false
  if (conn?.effectiveType === 'slow-2g' || conn?.effectiveType === '2g') return false
  return navigator.onLine !== false
}

function pump(): void {
  while (inFlight < CONCURRENCY && queue.length) {
    const { url } = queue.shift()!
    inFlight++
    const done = () => { inFlight--; pump() }
    // Already persisted client-side (IndexedDB image store): the card will paint from it
    // without a request, so warming the URL would spend bandwidth on nothing. The check
    // never rejects; a store error just falls through to a normal warm.
    void hasStoredImage(url).then((stored) => {
      if (stored) { done(); return }
      const img = new Image()
      img.decoding = 'async'
      // Property form (not an attribute) so browsers without it just ignore it.
      ;(img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = 'low'
      img.onload = done
      img.onerror = done
      img.src = url
    })
  }
}

/** Queue images for warming. `group` lets a caller drop its own not-yet-started entries
 *  when it unmounts (see cancelImagePreloads) so navigating away stops the drip. */
export function preloadImages(urls: (string | null | undefined)[], max = 12, group: symbol | null = null): void {
  let n = 0
  for (const url of urls) {
    if (!url || seen.has(url)) continue
    if (n >= max) break
    seen.add(url)
    n++
    queue.push({ url, group })
  }
  if (n) pump()
}

/** Drop this group's QUEUED warms (in-flight ones are already paid for and finish). The
 *  URLs stay in `seen`: they were intentionally skipped, and re-queuing them on a quick
 *  back-navigation would just re-race the same fetches. */
export function cancelImagePreloads(group: symbol): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.group === group) {
      seen.delete(queue[i]!.url)
      queue.splice(i, 1)
    }
  }
}
