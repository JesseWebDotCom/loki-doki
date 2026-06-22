// DeArrow — crowdsourced, de-clickbaited titles and thumbnails (same project as
// SponsorBlock). We swap a video's title/thumbnail for the community-voted alternative
// at render time. Fetched server-side so the browser never contacts a third party.
//
// Privacy batching: instead of asking for one video id at a time (which would leak the
// exact id and need one request per card), we hit the hashed-prefix endpoint
// `/api/branding/<first-4-hex-of-sha256(id)>`, which returns branding for EVERY video
// sharing that prefix. We fetch each distinct prefix once and pick out the ids we want.

import { createHash } from 'node:crypto'
import { logger } from '@/lib/logger'

const BRANDING = 'https://sponsor.ajay.app/api/branding'

export interface DeArrowBranding {
  title: string | null
  thumbTime: number | null   // timestamp (s) for the community thumbnail, or null
}

interface RawTitle { title: string; original: boolean; votes: number; locked: boolean }
interface RawThumb { timestamp: number | null; original: boolean; votes: number; locked: boolean }
interface RawBranding { titles?: RawTitle[]; thumbnails?: RawThumb[] }

// Locked entries win outright; otherwise the most up-voted non-original wins. A negative
// score with no lock means the community rejected it — fall back to YouTube's own.
function pickTitle(b: RawBranding): string | null {
  const cands = (b.titles ?? []).filter(t => !t.original)
  if (!cands.length) return null
  cands.sort((a, c) => (Number(c.locked) - Number(a.locked)) || (c.votes - a.votes))
  const best = cands[0]!
  if (best.votes < 0 && !best.locked) return null
  // DeArrow prefixes a word with `>` to opt it out of auto-title-casing; strip the marker.
  const title = best.title.replace(/(^|\s)>(\S)/g, '$1$2').trim()
  return title || null
}

function pickThumbTime(b: RawBranding): number | null {
  const cands = (b.thumbnails ?? []).filter(t => !t.original && t.timestamp != null)
  if (!cands.length) return null
  cands.sort((a, c) => (Number(c.locked) - Number(a.locked)) || (c.votes - a.votes))
  const best = cands[0]!
  return (best.votes >= 0 || best.locked) ? best.timestamp : null
}

const prefixOf = (videoId: string) => createHash('sha256').update(videoId).digest('hex').slice(0, 4)

export async function getDeArrowBatch(videoIds: string[], timeout = 6000): Promise<Record<string, DeArrowBranding>> {
  const out: Record<string, DeArrowBranding> = {}
  const byPrefix = new Map<string, string[]>()
  for (const id of [...new Set(videoIds)]) {
    const p = prefixOf(id)
    const arr = byPrefix.get(p) ?? []
    arr.push(id)
    byPrefix.set(p, arr)
  }
  await Promise.all([...byPrefix].map(async ([prefix, ids]) => {
    try {
      const res = await fetch(`${BRANDING}/${prefix}`, {
        headers: { 'User-Agent': 'LokiDoki/1.0' },
        signal: AbortSignal.timeout(timeout),
      })
      if (!res.ok) return
      const data = (await res.json()) as Record<string, RawBranding>
      for (const id of ids) {
        const b = data[id]
        if (!b) continue
        const title = pickTitle(b)
        const thumbTime = pickThumbTime(b)
        if (title || thumbTime != null) out[id] = { title, thumbTime }
      }
    } catch (err) {
      logger.warn(`[youtube/dearrow] prefix ${prefix} failed: ${err}`)
    }
  }))
  return out
}

// The DeArrow thumbnail-cache server renders a frame at the chosen timestamp. We proxy
// its bytes (separate host from the YouTube image cache) so the browser stays off it.
const THUMB = 'https://dearrow-thumb.ajay.app/api/v1/getThumbnail'

export async function fetchDeArrowThumb(videoId: string, time: number, timeout = 10000): Promise<Response | null> {
  try {
    const res = await fetch(`${THUMB}?videoID=${encodeURIComponent(videoId)}&time=${time}`, {
      headers: { 'User-Agent': 'LokiDoki/1.0' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok || !res.body) return null
    return res
  } catch (err) {
    logger.warn(`[youtube/dearrow] thumb ${videoId}@${time} failed: ${err}`)
    return null
  }
}
