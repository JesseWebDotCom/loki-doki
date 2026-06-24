// Common Sense Media parents guide for a title — age rating, "parents need to know", and
// per-category severity. Thin cached wrapper over the existing briefing CSM scraper so both
// the Shows and Movies apps (and the content-policy surface) can show the same data without
// re-scraping. 30-day cache; null when no review page exists.

import { commonSenseRating, type ContentRating } from '@/lib/briefing/sources/commonSense'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import type { MediaKind } from './types'

export type { ContentRating } from '@/lib/briefing/sources/commonSense'

export async function getParentsGuide(title: string, year: string | null, kind: MediaKind): Promise<ContentRating | null> {
  const key = `${kind}:${title.toLowerCase()}:${year ?? ''}`
  return cachedLookup('title-parents-guide', key, THIRTY_DAYS_MS, () =>
    commonSenseRating(`${title}${year ? ` ${year}` : ''} ${kind === 'movie' ? 'movie' : 'tv show'}`),
  )
}
