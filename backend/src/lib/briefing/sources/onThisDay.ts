// "On this day" via the free Wikimedia feed API (no key). Supports multiple feeds:
//   selected — curated notable events     births — notable people born today
//   events   — all historical events      deaths — notable people who died today
// Shared by the briefing refresher and the onThisDay reactive tool.

import type { BriefingItem } from '../types'

export type OnThisDayFeed = 'selected' | 'births' | 'deaths' | 'events'

interface FeedPage {
  thumbnail?: { source?: string; width?: number; height?: number }
  originalimage?: { source?: string }
}
interface FeedEntry {
  year?: number
  text?: string
  pages?: FeedPage[]
}

// Wikimedia thumbnails come sized (e.g. `.../330px-Foo.jpg`); bump to a crisper card width.
function upscaleThumb(url: string): string {
  return url.replace(/\/\d+px-/, '/640px-')
}

// First page with usable artwork → a real historical photo/portrait for the card.
function entryImage(e: FeedEntry): string | undefined {
  for (const p of e.pages ?? []) {
    const src = p.thumbnail?.source ?? p.originalimage?.source
    if (src && /^https?:/i.test(src)) return upscaleThumb(src)
  }
  return undefined
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatEntry(e: FeedEntry, feed: OnThisDayFeed): string {
  const text = (e.text ?? '').trim()
  if (!e.year) return text
  // Births/deaths read better with the year as a suffix; events with it as a prefix.
  if (feed === 'births') return `${text} (b. ${e.year})`
  if (feed === 'deaths') return `${text} (d. ${e.year})`
  return `${e.year} — ${text}`
}

/**
 * Entries for a given feed and date (defaults to today, server-local). Throws on failure
 * so the refresher's allSettled marks the source degraded / the tool reports offline.
 */
// Day-keyed cache of the FULL feed per (feed, date), so the standalone route (limit 12),
// the briefing refresher (limit ~3), and the boot warmer share one Wikimedia fetch per
// feed per day. Limits slice the cached list per call. Bounded: old date keys pruned.
const feedCache = new Map<string, FeedEntry[]>()
const feedInFlight = new Map<string, Promise<FeedEntry[]>>()

async function fetchFeedCached(feed: OnThisDayFeed, month: number, day: number, timeoutMs: number): Promise<FeedEntry[]> {
  const key = `${feed}:${pad2(month)}-${pad2(day)}`
  const hit = feedCache.get(key)
  if (hit) return hit
  const inflight = feedInFlight.get(key)
  if (inflight) return inflight
  const p = (async () => {
    const res = await fetch(
      `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/${feed}/${pad2(month)}/${pad2(day)}`,
      { headers: { 'User-Agent': 'LokiDoki/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) },
    )
    if (!res.ok) throw new Error(`onThisDay(${feed}): ${res.status}`)
    const data = (await res.json()) as Record<string, FeedEntry[] | undefined>
    const entries = Array.isArray(data[feed]) ? (data[feed] as FeedEntry[]) : []
    // Yesterday's keys are dead weight: keep the map to roughly one day's feeds.
    if (feedCache.size >= 8) {
      for (const k of feedCache.keys()) if (!k.endsWith(`${pad2(month)}-${pad2(day)}`)) feedCache.delete(k)
    }
    feedCache.set(key, entries)
    return entries
  })()
  feedInFlight.set(key, p)
  try { return await p } finally { feedInFlight.delete(key) }
}

export async function onThisDay(
  opts: { month?: number; day?: number; limit?: number; feed?: OnThisDayFeed } = {},
  timeoutMs = 5000,
): Promise<BriefingItem[]> {
  const now = new Date()
  const month = opts.month ?? now.getMonth() + 1
  const day = opts.day ?? now.getDate()
  const limit = opts.limit ?? 3
  const feed = opts.feed ?? 'selected'

  const entries = await fetchFeedCached(feed, month, day, timeoutMs)
  return entries
    .filter((e) => e.text)
    .slice(0, limit)
    .map((e) => ({ title: formatEntry(e, feed), imageUrl: entryImage(e) }))
}
