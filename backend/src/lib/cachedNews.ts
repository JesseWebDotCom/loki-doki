// Local cached-news lookup over already-fetched feed items (feed_items). Lets the
// search tool answer "do we already have recent news on X?" straight from disk —
// the first, zero-network tier of the layered search flow — before reaching for the
// open web. Scoped to system feeds (userId null) plus the asking user's own feeds.
//
// Matching is token-AND over the query's significant words (stopwords dropped): a
// natural-language question like "is corey feldman still alive" reduces to
// {corey, feldman, alive}, and an item must contain ALL of them (in title or
// summary) to count — keeping precision high so we never lead an answer with a
// tangential headline.

import { db, sqlite } from '@/db'
import { feedItems, feeds } from '@/db/schema'
import { and, desc, eq, isNull, like, or, type SQL } from 'drizzle-orm'
import { stripTags } from '@/lib/htmlText'

export interface CachedNewsItem {
  title: string
  snippet: string
  url: string
  source: string
  publishedAt: number | null
}

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'of', 'to', 'in', 'on',
  'for', 'and', 'or', 'still', 'what', 'who', 'whom', 'when', 'where', 'why', 'how', 'about',
  'any', 'have', 'has', 'had', 'that', 'this', 'with', 'from', 'it', 'its', 'i', 'you', 'he',
  'she', 'they', 'we', 'me', 'my', 'now', 'today', 'recent', 'latest', 'news', 'tell',
])

function significantTerms(q: string): string[] {
  return [...new Set(q.toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter(w => w.length >= 3 && !STOP.has(w))
    .slice(0, 5)
}

function likeAny(term: string): SQL {
  const p = `%${term.replace(/[%_]/g, '')}%`
  return or(like(feedItems.title, p), like(feedItems.summary, p))!
}

/**
 * Search cached feed items for the query's significant terms. FTS5 (bm25 relevance
 * blended with a recency prior) is the primary path; the original token-AND LIKE
 * scan is the fallback when the FTS mirror is unavailable. Returns up to `limit`
 * items, or [] if the query is too thin or nothing matches. Never throws.
 */
export async function searchCachedNews(
  query: string,
  userId: string | undefined,
  limit = 4,
): Promise<CachedNewsItem[]> {
  const terms = significantTerms(query)
  if (terms.length === 0) return []

  // ── FTS5 path: bm25 + recency prior ──────────────────────────────────────
  // OR-match so partial term hits still rank (bm25 rewards more matches), then
  // blend with freshness in JS: for NEWS, a 2-day-old exact match beats a
  // 3-week-old slightly-better match (the simple-recency-prior finding).
  try {
    const match = terms.map((t) => `"${t}"`).join(' OR ')
    const rows = sqlite.query(
      `SELECT fi.title AS title, fi.summary AS summary, fi.url AS url,
              fi.published_at AS publishedAt, f.title AS feedTitle,
              bm25(feed_items_fts) AS rank
       FROM feed_items_fts
       JOIN feed_items fi ON fi.rowid = feed_items_fts.rowid
       JOIN feeds f ON f.id = fi.feed_id
       WHERE feed_items_fts MATCH ?
         AND (f.user_id IS NULL${userId ? ' OR f.user_id = ?' : ''})
       ORDER BY rank LIMIT 30`,
    ).all(...(userId ? [match, userId] : [match])) as Array<{
      title: string | null; summary: string | null; url: string | null
      publishedAt: number | null; feedTitle: string | null; rank: number
    }>

    if (rows.length > 0) {
      const now = Date.now()
      // Precision gate (keeps the old token-AND spirit): an item must contain
      // most of the query's terms — bm25 alone would let a single-term match
      // lead the answer with a tangential headline.
      const need = terms.length >= 3 ? terms.length - 1 : terms.length
      const scored = rows
        .filter((r) => r.title && r.url)
        .filter((r) => {
          const hay = `${r.title} ${r.summary ?? ''}`.toLowerCase()
          return terms.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0) >= need
        })
        .map((r) => {
          const ageDays = r.publishedAt ? Math.max(0, (now - r.publishedAt) / 86_400_000) : 30
          // bm25 is lower-is-better; add an age penalty so stale items sink.
          return { r, score: r.rank + Math.min(ageDays, 30) * 0.3 }
        })
        .sort((a, b) => a.score - b.score)
        .slice(0, limit)
      return scored.map(({ r }) => ({
        title: stripTags(r.title!),
        snippet: stripTags(r.summary ?? ''),
        url: r.url!,
        source: r.feedTitle || 'News',
        publishedAt: r.publishedAt ?? null,
      }))
    }
  } catch { /* FTS mirror missing/corrupt — fall through to LIKE */ }

  // ── Fallback: original token-AND LIKE scan ───────────────────────────────
  const scope = userId ? or(isNull(feeds.userId), eq(feeds.userId, userId)) : isNull(feeds.userId)

  try {
    const rows = await db
      .select({
        title: feedItems.title,
        summary: feedItems.summary,
        url: feedItems.url,
        publishedAt: feedItems.publishedAt,
        feedTitle: feeds.title,
      })
      .from(feedItems)
      .innerJoin(feeds, eq(feedItems.feedId, feeds.id))
      .where(and(scope, ...terms.map(likeAny)))
      .orderBy(desc(feedItems.publishedAt))
      .limit(limit)

    return rows
      .filter(r => r.title && r.url)
      .map(r => ({
        title: stripTags(r.title!),
        snippet: stripTags(r.summary ?? ''),
        url: r.url!,
        source: r.feedTitle || 'News',
        publishedAt: r.publishedAt ?? null,
      }))
  } catch {
    return []
  }
}
