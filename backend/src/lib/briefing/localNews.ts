// Shared local-news blend: Patch + Daily Voice (CT/NY/NJ/PA/MA) + Bing News RSS,
// round-robin merged and deduped by title. ONE place so every surface that shows local news
// (the ambient companion briefing, the News app's "Local" tab, and the localNews/localEvents
// reactive tools) stays in sync — adding/removing/reordering a source here changes it
// everywhere instead of requiring a per-call-site edit.
//
// Bing over Google here specifically: this surface renders image cards, and Google News RSS
// links are a client-JS-only redirect with no real per-article image (see ogImage.ts
// isGoogleNewsRedirect) — Bing's redirect is plainly decodable and carries a real thumbnail.

import type { BriefingItem } from './types'
import { patchLocal } from './sources/patch'
import { dailyVoiceLocal } from './sources/dailyvoice'
import { deriveDailyVoiceSlug } from './slug'
import { bingNewsSearch } from './sources/rss'

/**
 * Round-robin merge of local-news lists (in priority order), deduped by title, capped to
 * `limit`. Keeps the first list first-past-the-post (it's usually the richest source) while
 * still surfacing the others rather than only appearing when it comes up short.
 */
export function mergeLocalNews(lists: BriefingItem[][], limit: number): BriefingItem[] {
  const merged: BriefingItem[] = []
  const seen = new Set<string>()
  const add = (it: BriefingItem) => {
    const key = it.title.toLowerCase().slice(0, 60)
    if (seen.has(key)) return
    seen.add(key)
    merged.push(it)
  }
  const maxLen = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; merged.length < limit && i < maxLen; i++) {
    for (const list of lists) {
      if (merged.length >= limit) break
      if (list[i]) add(list[i]!)
    }
  }
  return merged.slice(0, limit)
}

export interface BlendedLocalNews {
  news: BriefingItem[]
  events: BriefingItem[] // Patch-only — Daily Voice/Google News RSS carry no distinct events feed
}

/**
 * Blended local news for `townLabel` ("Milford, CT"): Patch + Daily Voice (when the town's in
 * CT/NY/NJ/PA/MA) + Bing News RSS. Each source swallows its own errors, so this never
 * throws — a source that fails just contributes an empty list to the merge.
 */
export async function blendedLocalNews(opts: {
  patchSlug: string | null
  townLabel: string
  limit: number
}): Promise<BlendedLocalNews> {
  const { patchSlug, townLabel, limit } = opts
  const dvSlug = deriveDailyVoiceSlug(townLabel)
  // Over-ask each source: the round-robin merge dedupes across sources, and callers that
  // persist the blend (the News app's Local history store) accumulate faster when every
  // fetch surfaces a source's full front page rather than just the top `limit` slice.
  // The final merge below still honors the caller's `limit`.
  const perSource = Math.max(limit, 30)
  const [patchResult, dvNews, bnNews] = await Promise.all([
    patchLocal({ slug: patchSlug, townLabel, limit: perSource }),
    dvSlug ? dailyVoiceLocal(dvSlug, perSource) : Promise.resolve<BriefingItem[]>([]),
    bingNewsSearch(`${townLabel} news`, perSource, 7000)
      .then((items) => items.map((i): BriefingItem => ({ title: i.title, detail: i.source || undefined, url: i.url || undefined, imageUrl: i.imageUrl })))
      .catch(() => [] as BriefingItem[]),
  ])
  return {
    news: mergeLocalNews([patchResult.news, dvNews, bnNews], limit),
    events: patchResult.events,
  }
}
