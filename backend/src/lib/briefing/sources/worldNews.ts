// World/national headlines for the briefing + the (existing) news tool already covers
// general news; this is the briefing's compact world slice.

import type { BriefingItem } from '../types'
import { worldHeadlines } from './rss'

export async function worldNews(limit = 2, timeoutMs = 5000): Promise<BriefingItem[]> {
  // Publisher feeds (NYT/Guardian/BBC) over the Google News topic feed: the latter has no
  // usable per-article image, the former carry real media:* images + summaries the UI cards want.
  const items = await worldHeadlines(limit, timeoutMs)
  return items.map((i) => ({
    title: i.title,
    detail: i.source || undefined,
    url: i.url,
    imageUrl: i.imageUrl,
    summary: i.summary,
    publishedAt: i.publishedAt,
  }))
}
