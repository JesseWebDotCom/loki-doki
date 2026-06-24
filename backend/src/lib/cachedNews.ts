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

import { db } from '@/db'
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
 * Search cached feed items for the query's significant terms (all must match).
 * Returns up to `limit` most-recent items, or [] if the query is too thin or nothing
 * matches. Never throws.
 */
export async function searchCachedNews(
  query: string,
  userId: string | undefined,
  limit = 4,
): Promise<CachedNewsItem[]> {
  const terms = significantTerms(query)
  if (terms.length === 0) return []

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
