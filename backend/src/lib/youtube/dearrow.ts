// DeArrow — crowdsourced, de-clickbaited titles and thumbnails (same project as
// SponsorBlock). We swap a video's title/thumbnail for the community-voted alternative
// at render time. Fetched server-side so the browser never contacts a third party.
//
// Privacy batching: instead of asking for one video id at a time (which would leak the
// exact id and need one request per card), we hit the hashed-prefix endpoint
// `/api/branding/<first-4-hex-of-sha256(id)>`, which returns branding for EVERY video
// sharing that prefix. We fetch each distinct prefix once and pick out the ids we want.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '@/lib/download'
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

// Per-prefix response cache + inflight dedupe: the API is queried by 4-char prefix, so
// two batches sharing a prefix (the same feed re-rendering, overlapping rails) reuse one
// upstream response instead of re-fetching. Branding votes move slowly; 30 min is plenty.
const PREFIX_TTL_MS = 30 * 60 * 1000
const prefixCache = new Map<string, { data: Record<string, RawBranding>; expires: number }>()
const prefixInflight = new Map<string, Promise<Record<string, RawBranding> | null>>()
/** Cap on concurrent prefix fetches — a 100-id batch fans out to ~100 distinct prefixes,
 *  which as parallel requests looks like a burst attack to sponsor.ajay.app. */
const PREFIX_CONCURRENCY = 8

async function fetchBrandingPrefix(prefix: string, timeout: number): Promise<Record<string, RawBranding> | null> {
  const hit = prefixCache.get(prefix)
  if (hit && hit.expires > Date.now()) return hit.data
  if (hit) prefixCache.delete(prefix)
  const pending = prefixInflight.get(prefix)
  if (pending) return pending
  const p = (async (): Promise<Record<string, RawBranding> | null> => {
    try {
      const res = await fetch(`${BRANDING}/${prefix}`, {
        headers: { 'User-Agent': 'MaiPaiHome/1.0' },
        signal: AbortSignal.timeout(timeout),
      })
      if (!res.ok) return null
      const data = (await res.json()) as Record<string, RawBranding>
      if (prefixCache.size > 2000) {
        const now = Date.now()
        for (const [k, v] of prefixCache) if (v.expires <= now) prefixCache.delete(k)
      }
      prefixCache.set(prefix, { data, expires: Date.now() + PREFIX_TTL_MS })
      return data
    } catch (err) {
      logger.warn(`[youtube/dearrow] prefix ${prefix} failed: ${err}`)
      return null   // failures are not cached — the next batch retries
    }
  })()
  prefixInflight.set(prefix, p)
  void p.finally(() => { if (prefixInflight.get(prefix) === p) prefixInflight.delete(prefix) })
  return p
}

export async function getDeArrowBatch(videoIds: string[], timeout = 6000): Promise<Record<string, DeArrowBranding>> {
  const out: Record<string, DeArrowBranding> = {}
  const byPrefix = new Map<string, string[]>()
  for (const id of [...new Set(videoIds)]) {
    const p = prefixOf(id)
    const arr = byPrefix.get(p) ?? []
    arr.push(id)
    byPrefix.set(p, arr)
  }
  // Small worker pool over the prefixes (cache hits cost nothing, misses respect the cap).
  const queue = [...byPrefix]
  await Promise.all(Array.from({ length: Math.min(PREFIX_CONCURRENCY, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [prefix, ids] = job
      const data = await fetchBrandingPrefix(prefix, timeout)
      if (!data) continue
      for (const id of ids) {
        const b = data[id]
        if (!b) continue
        const title = pickTitle(b)
        const thumbTime = pickThumbTime(b)
        if (title || thumbTime != null) out[id] = { title, thumbTime }
      }
    }
  }))
  return out
}

// The DeArrow thumbnail-cache server renders a frame at the chosen timestamp. We proxy
// its bytes (separate host from the YouTube image cache) so the browser stays off it.
const THUMB = 'https://dearrow-thumb.ajay.app/api/v1/getThumbnail'

async function fetchDeArrowThumb(videoId: string, time: number, timeout = 10000): Promise<Response | null> {
  try {
    const res = await fetch(`${THUMB}?videoID=${encodeURIComponent(videoId)}&time=${time}`, {
      headers: { 'User-Agent': 'MaiPaiHome/1.0' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok || !res.body) return null
    return res
  } catch (err) {
    logger.warn(`[youtube/dearrow] thumb ${videoId}@${time} failed: ${err}`)
    return null
  }
}

// Read-through disk cache for rendered thumbs, same pattern as imageCache.getOrFetchImage:
// upstream renders the frame on demand (expensive), but a frame for a given id@time never
// changes — so cache it on disk and serve every later request off it. Layout mirrors
// lib/imageProxy: bytes at data/dearrow-thumb-cache/<key>, content-type in a `.t` sidecar.
const THUMB_CACHE_DIR = join(dataDir, 'dearrow-thumb-cache')
// Frames are immutable, so the sweep is purely a disk bound: once per boot, drop files a
// month old (feeds churn, so untouched thumbs are dead weight by then).
const THUMB_SWEEP_AGE_MS = 30 * 24 * 60 * 60 * 1000
const thumbInflight = new Map<string, Promise<{ data: Buffer; contentType: string } | null>>()
let thumbSweep: Promise<void> | null = null

/** Cache key (and the route's ETag source) for one rendered frame. */
export const deArrowThumbKey = (videoId: string, time: number): string =>
  createHash('sha256').update(`dearrow:${videoId}@${time}`).digest('hex')

async function sweepThumbCache(): Promise<void> {
  const cutoff = Date.now() - THUMB_SWEEP_AGE_MS
  for (const f of await readdir(THUMB_CACHE_DIR).catch(() => [] as string[])) {
    try {
      const p = join(THUMB_CACHE_DIR, f)
      if ((await stat(p)).mtimeMs < cutoff) await unlink(p)
    } catch { /* race with a write — skip */ }
  }
}

/** Read-through accessor used by the /dearrow-thumb proxy. Serves cached bytes off disk,
 *  fetching (one upstream render) and persisting on a miss. Null = upstream failure. */
export async function getOrFetchDeArrowThumb(videoId: string, time: number): Promise<{ data: Buffer; contentType: string } | null> {
  thumbSweep ??= sweepThumbCache().catch(() => {})
  const key = deArrowThumbKey(videoId, time)
  const bytesPath = join(THUMB_CACHE_DIR, key)
  try {
    const [data, contentType] = await Promise.all([
      readFile(bytesPath),
      readFile(`${bytesPath}.t`, 'utf8').catch(() => 'image/webp'),
    ])
    return { data, contentType: contentType.trim() || 'image/webp' }
  } catch { /* miss — fall through and fetch */ }

  const pending = thumbInflight.get(key)
  if (pending) return pending
  const p = (async () => {
    const res = await fetchDeArrowThumb(videoId, time)
    if (!res) return null
    const data = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') ?? 'image/webp'
    try {
      await mkdir(THUMB_CACHE_DIR, { recursive: true })
      await Promise.all([writeFile(bytesPath, data), writeFile(`${bytesPath}.t`, contentType)])
    } catch { /* cache write is best-effort — still serve the bytes */ }
    return { data, contentType }
  })()
  thumbInflight.set(key, p)
  void p.finally(() => { if (thumbInflight.get(key) === p) thumbInflight.delete(key) })
  return p
}
