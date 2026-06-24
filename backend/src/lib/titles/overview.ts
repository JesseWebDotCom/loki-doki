// Encyclopedic overview for a title — the Wikipedia lead paragraph. Keyless, cached.
// Shared by Shows and Movies for the "Overview" section (complements the source synopsis).

import { wikipediaSearch } from '@/lib/wikipediaSearch'
import { cachedLookup } from '@/lib/lookupCache'
import type { MediaKind } from './types'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export interface TitleOverview {
  text: string
  url: string
}

export async function getOverview(title: string, year: string | null, kind: MediaKind): Promise<TitleOverview | null> {
  const key = `${kind}:${title.toLowerCase()}:${year ?? ''}`
  return cachedLookup('title-overview', key, SEVEN_DAYS_MS, async () => {
    const noun = kind === 'movie' ? 'film' : 'TV series'
    const results = await wikipediaSearch(`${title} ${noun}`, 1)
    const top = results[0]
    if (!top || !top.snippet.trim()) return null
    return { text: top.snippet, url: top.url }
  })
}
