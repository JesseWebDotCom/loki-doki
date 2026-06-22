// SponsorBlock — community-sourced skip segments (sponsor reads, intros, self-promo,
// interaction reminders, etc.) keyed by video id. The player overlays them on the
// scrubber and can auto-skip. Public API, no key. We proxy it server-side so the
// browser never reveals which videos the user watches to a third party.

import { logger } from '@/lib/logger'

const API = 'https://sponsor.ajay.app/api/skipSegments'
const CATEGORIES = ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'preview', 'music_offtopic']

export interface SkipSegment {
  category: string
  start: number   // seconds
  end: number     // seconds
}

interface RawSegment {
  category: string
  actionType: string
  segment: [number, number]
}

export async function getSkipSegments(videoId: string, timeout = 6000): Promise<SkipSegment[]> {
  try {
    const cats = encodeURIComponent(JSON.stringify(CATEGORIES))
    const res = await fetch(`${API}?videoID=${encodeURIComponent(videoId)}&categories=${cats}`, {
      headers: { 'User-Agent': 'LokiDoki/1.0' },
      signal: AbortSignal.timeout(timeout),
    })
    // 404 = "no segments submitted for this video", which is the common, non-error case.
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`sponsorblock ${res.status}`)
    const data = (await res.json()) as RawSegment[]
    return (Array.isArray(data) ? data : [])
      .filter(s => s.actionType === 'skip' && Array.isArray(s.segment) && s.segment.length === 2)
      .map(s => ({ category: s.category, start: s.segment[0], end: s.segment[1] }))
      .sort((a, b) => a.start - b.start)
  } catch (err) {
    logger.warn(`[youtube/sponsorblock] lookup failed for ${videoId}: ${err}`)
    return []
  }
}
