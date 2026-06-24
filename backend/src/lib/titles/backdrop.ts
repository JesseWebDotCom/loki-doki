// Wallpaper backdrop finder. The detail pages use a full-bleed blurred backdrop behind the
// content; the best source is a wide (landscape) promo still. TVMaze exposes real
// background art for many shows (used directly by the shows aggregator); this is the shared
// fallback for everything else — a keyless image search biased toward large, landscape art.
//
// Returns a raw image URL (any host) or null. The frontend loads it directly or via the
// /api/media/img proxy when the host is allowlisted. Cached a week.

import { searxngImageSearch } from '@/lib/searxng'
import { cachedLookup } from '@/lib/lookupCache'
import type { MediaKind } from './types'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export async function findBackdrop(title: string, year: string | null, kind: MediaKind): Promise<string | null> {
  const key = `${kind}:${title.toLowerCase()}:${year ?? ''}`
  return cachedLookup('title-backdrop', key, ONE_WEEK_MS, async () => {
    const noun = kind === 'movie' ? 'movie' : 'tv show'
    const y = year ? ` ${year}` : ''
    const imgs = await searxngImageSearch(`${title}${y} ${noun} backdrop still wallpaper`, 12)
    if (!imgs.length) return null

    const scored = imgs
      .map((img) => {
        const w = img.width ?? 0
        const h = img.height ?? 0
        const landscape = w > 0 && h > 0 && w >= h * 1.3
        // Prefer landscape + decent width; unknown-dimension results rank below known-good ones.
        const score = (landscape ? 1000 : 0) + Math.min(w, 4000)
        return { url: img.imageUrl, landscape, w, h, score }
      })
      .filter((s) => s.url.startsWith('http'))
      .sort((a, b) => b.score - a.score)

    // Take the best landscape; if none have known dimensions, fall back to the top result.
    const best = scored.find((s) => s.landscape) ?? scored[0]
    return best?.url ?? null
  })
}
