// Stable identity for "the set of SponsorBlock categories a user has chosen to strip for
// Plex." Used both as the derived media_assets.format suffix (so two users with identical
// enabled categories share one cut rendition, dedup-safe) and as the invalidation key
// against yt_plex_episodes.cutCategoriesHash (a later pref change triggers a re-cut).

import { createHash } from 'node:crypto'
import type { SkipCategory } from '@/lib/youtube/sponsorblock'

/** Deterministic short hash of the sorted enabled-category list — order-independent,
 *  so toggling categories off then back on in a different order still hits the cache. */
export function cutSetHash(enabled: Record<SkipCategory, boolean>): string {
  const keys = Object.keys(enabled).filter(k => enabled[k as SkipCategory]).sort()
  return createHash('sha256').update(keys.join(',')).digest('hex').slice(0, 12)
}

/** Whether this category map would cut anything at all — an all-false map (or a video
 *  with no matching SponsorBlock segments) means "use the original, no cut needed." */
export function hasAnyEnabled(enabled: Record<SkipCategory, boolean>): boolean {
  return Object.values(enabled).some(Boolean)
}
