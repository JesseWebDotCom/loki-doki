// Shared "is this actually the article, or just a thin RSS teaser" gate, used by both the
// in-app reader's /content endpoint and the AI summary endpoint so they agree on what counts
// as substantial. Many RSS feeds ship a teaser-only content:encoded (a sentence or a lone
// image, meant to drive a click-through) rather than the full body.

import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { feedItems } from '@/db/schema'
import { extractArticle, stripHtml } from '@/lib/content/extract'
import { logger } from '@/lib/logger'

export const MIN_FEED_CONTENT_CHARS = 400

// Remember URLs whose extraction just failed (bot-blocked, dead link) so opening the article
// shows its fallback instantly instead of re-running a doomed ~15s fetch+wayback attempt on
// every click. In-memory on purpose: a restart or the TTL retries for real.
const EXTRACT_FAIL_TTL_MS = 30 * 60 * 1000
const recentExtractFailures = new Map<string, number>()

function markExtractFailure(url: string): void {
  if (recentExtractFailures.size > 500) {
    for (const [u, at] of recentExtractFailures) {
      if (Date.now() - at > EXTRACT_FAIL_TTL_MS) recentExtractFailures.delete(u)
    }
  }
  recentExtractFailures.set(url, Date.now())
}

function recentlyFailed(url: string): boolean {
  const at = recentExtractFailures.get(url)
  return !!at && Date.now() - at < EXTRACT_FAIL_TTL_MS
}

function clearExtractFailure(url: string): void {
  recentExtractFailures.delete(url)
}

export interface FullContent {
  contentHtml: string | null
  title: string | null
  author: string | null
  siteName: string | null
  readingMins: number
  /** True when contentHtml is just the feed-provided teaser because the full article could not
   *  be fetched (bot-blocked, paywalled, dead link). The reader shows a notice + Open Original. */
  teaserOnly: boolean
  /** Lead image for the teaser view (the feed's own image), so the fallback still reads like
   *  an article page rather than a bare sentence. */
  imageUrl: string | null
  source: 'direct' | 'social' | 'subscriber' | 'browser' | 'ladder' | 'archive.is' | 'wayback' | null
  archiveUrl: string | null
}

function readingMinsFor(html: string): number {
  return Math.max(1, Math.round(stripHtml(html).split(/\s+/).filter(Boolean).length / 200))
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Last-resort view when the article itself is unreachable (e.g. DataDome-style bot blocks with
// no public archive copy either): the description the PUBLISHER put in their own RSS feed.
// Not persisted to feedItems.contentHtml - it isn't article content, and caching it would stop
// a future open from retrying the real extraction.
function teaserFallback(row: typeof feedItems.$inferSelect): FullContent {
  const teaser = row.summary?.trim()
  return {
    contentHtml: teaser ? `<p>${escapeHtml(teaser)}</p>` : null,
    title: row.title, author: row.author, siteName: null,
    readingMins: 0, teaserOnly: !!teaser, imageUrl: row.imageUrl ?? null,
    source: null, archiveUrl: null,
  }
}

/** Returns the row's cached content if it's already substantial, else extracts (and persists)
 *  the full article. A failed/thin extraction (paywall, bot-blocked) falls back to whatever
 *  was cached - or, with nothing cached at all, to the feed's own teaser - rather than
 *  erasing/omitting a shorter-but-real preview. */
export async function ensureFullContent(row: typeof feedItems.$inferSelect, opts: { force?: boolean } = {}): Promise<FullContent> {
  const cachedTextLen = row.contentHtml ? stripHtml(row.contentHtml).length : 0
  if (cachedTextLen >= MIN_FEED_CONTENT_CHARS || !row.url) {
    if (!row.contentHtml) return teaserFallback(row)
    return {
      contentHtml: row.contentHtml, title: row.title, author: row.author, siteName: null,
      readingMins: readingMinsFor(row.contentHtml), teaserOnly: false, imageUrl: null,
      source: null, archiveUrl: null,
    }
  }
  // A fresh known-bad URL: skip straight to the fallback rather than re-running the fetch.
  if (opts.force) clearExtractFailure(row.url)
  if (!opts.force && recentlyFailed(row.url)) {
    if (!row.contentHtml) return teaserFallback(row)
    return {
      contentHtml: row.contentHtml, title: row.title, author: row.author, siteName: null,
      readingMins: readingMinsFor(row.contentHtml), teaserOnly: false, imageUrl: null,
      source: null, archiveUrl: null,
    }
  }
  try {
    const a = await extractArticle(row.url)
    const extractedTextLen = a.contentText?.length ?? 0
    const best = extractedTextLen > cachedTextLen ? a.contentHtml : row.contentHtml
    if (!best) return teaserFallback(row)
    if (best !== row.contentHtml) await db.update(feedItems).set({ contentHtml: best }).where(eq(feedItems.id, row.id))
    return {
      contentHtml: best, title: row.title || a.title, author: row.author ?? a.byline, siteName: a.siteName,
      readingMins: extractedTextLen > cachedTextLen ? a.readingMins : readingMinsFor(best),
      teaserOnly: false, imageUrl: null,
      source: extractedTextLen > cachedTextLen ? a.source : null,
      archiveUrl: extractedTextLen > cachedTextLen ? a.archiveUrl : null,
    }
  } catch {
    markExtractFailure(row.url)
    if (!row.contentHtml) return teaserFallback(row)
    return {
      contentHtml: row.contentHtml, title: row.title, author: row.author, siteName: null,
      readingMins: readingMinsFor(row.contentHtml), teaserOnly: false, imageUrl: null,
      source: null, archiveUrl: null,
    }
  }
}

// ── background prefetch (poller) ─────────────────────────────────────────────────

// Extract new items' full content as they arrive from the feed poller, so opening an article
// is instant instead of paying the extraction fetch on first click. Serialized with a small
// per-item gap (politeness toward article hosts - the poller only throttles FEED hosts), and
// capped per batch: a normal poll adds a handful of items; a freshly-added feed's initial
// backfill (up to ~200) stays lazy beyond the newest few.
const PREFETCH_MAX_PER_BATCH = 10
const PREFETCH_GAP_MS = 300
let prefetchQueue: Promise<void> = Promise.resolve()

export function prefetchFeedItemContent(itemIds: string[]): void {
  const ids = itemIds.slice(0, PREFETCH_MAX_PER_BATCH)
  if (!ids.length) return
  prefetchQueue = prefetchQueue.then(async () => {
    const rows = await db.select().from(feedItems).where(inArray(feedItems.id, ids))
    let extracted = 0
    for (const row of rows) {
      try {
        const full = await ensureFullContent(row)
        if (full.contentHtml && !full.teaserOnly) extracted++
      } catch { /* per-item best effort */ }
      await new Promise((r) => setTimeout(r, PREFETCH_GAP_MS))
    }
    if (extracted) logger.info(`[feeds] prefetched content for ${extracted}/${rows.length} new items`)
  }).catch(() => {})
}
