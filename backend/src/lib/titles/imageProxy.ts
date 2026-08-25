// Generic read-through image proxy for the Shows / Movies apps. Posters, backdrops and
// stills come from a handful of external hosts (TVMaze, JustWatch, Wikimedia, Fandango);
// rather than let the browser hit those directly (mixed-content, CDN rate limits, and the
// caller leaking the user's IP to each host), the frontend renders every image through
// /api/media/img?u=<url>, which fills this disk cache lazily.
//
// Simpler than the YouTube image cache (no subscription renewal): bytes land at
// data/media-image-cache/<sha256>, with the content-type in a tiny <sha256>.t sidecar so a
// cache hit can serve the right MIME. Files are immutable per URL, so there's no renewal —
// a periodic sweep (mediaImageCacheSweep) just bounds total size.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'
import { safeFetch } from '@/lib/ssrfGuard'

const CACHE_DIR = join(dataDir, 'media-image-cache')
const FETCH_TIMEOUT_MS = 10_000
const MAX_CACHE_BYTES = 512 * 1024 * 1024 // 512 MB ceiling, swept down on boot + daily

// Only proxy from known media-art hosts. Keep this list tight — it's an SSRF guard.
const ALLOWED_HOST =
  /(^|\.)(tvmaze\.com|justwatch\.com|wikimedia\.org|wikipedia\.org|fandango\.com|fandangob2c\.cmgdigital\.com|ytimg\.com|ggpht\.com)$/i

export function isProxiableImage(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)
    return (u.protocol === 'https:' || u.protocol === 'http:') && ALLOWED_HOST.test(u.hostname)
  } catch {
    return false
  }
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

/** Width-hinted accessor (?w=): bucketed webp downscale beside the original, falling
 *  back to the original whenever resizing isn't possible. Mirrors lib/imageProxy. */
export async function getOrFetchMediaImageResized(rawUrl: string, w: string | undefined): Promise<{ data: Buffer; contentType: string } | null> {
  const orig = await getOrFetchMediaImage(rawUrl)
  if (!orig) return null
  const { bucketFor, getResizedVariant } = await import('@/lib/imageResize')
  const bucket = bucketFor(w)
  if (!bucket) return orig
  const variant = await getResizedVariant(join(CACHE_DIR, hashUrl(rawUrl)), orig.contentType, bucket)
  return variant ?? orig
}

/** Read-through accessor used by the /api/media/img proxy. Returns null for a forbidden
 *  host or an upstream failure. */
export async function getOrFetchMediaImage(rawUrl: string): Promise<{ data: Buffer; contentType: string } | null> {
  if (!isProxiableImage(rawUrl)) return null

  const hash = hashUrl(rawUrl)
  const bytesPath = join(CACHE_DIR, hash)
  const typePath = join(CACHE_DIR, `${hash}.t`)

  if (existsSync(bytesPath)) {
    try {
      const [data, contentType] = await Promise.all([
        readFile(bytesPath),
        readFile(typePath, 'utf8').catch(() => 'image/jpeg'),
      ])
      return { data, contentType: contentType.trim() || 'image/jpeg' }
    } catch {
      /* unreadable — fall through and re-fetch */
    }
  }

  try {
    // safeFetch re-validates every redirect hop so an allowlisted CDN can't open-redirect us
    // to an internal address.
    const res = await safeFetch(rawUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaiPaiHome/1.0)', Accept: 'image/*' },
    }, { timeoutMs: FETCH_TIMEOUT_MS })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? 'image/jpeg'
    if (!contentType.startsWith('image/')) return null
    const data = Buffer.from(await res.arrayBuffer())
    await mkdir(CACHE_DIR, { recursive: true })
    await Promise.all([writeFile(bytesPath, data), writeFile(typePath, contentType)])
    return { data, contentType }
  } catch {
    return null
  }
}

/** Bound the cache: if total bytes exceed the ceiling, delete oldest files first. */
export async function mediaImageCacheSweep(): Promise<void> {
  try {
    if (!existsSync(CACHE_DIR)) return
    const files = await readdir(CACHE_DIR)
    const entries = await Promise.all(
      files.map(async (f) => {
        try {
          const s = await stat(join(CACHE_DIR, f))
          return { f, size: s.size, mtime: s.mtimeMs }
        } catch {
          return null
        }
      }),
    )
    const live = entries.filter((e): e is { f: string; size: number; mtime: number } => e !== null)
    let total = live.reduce((n, e) => n + e.size, 0)
    if (total <= MAX_CACHE_BYTES) return
    live.sort((a, b) => a.mtime - b.mtime) // oldest first
    for (const e of live) {
      if (total <= MAX_CACHE_BYTES) break
      try {
        await unlink(join(CACHE_DIR, e.f))
        total -= e.size
      } catch {
        /* race with a write — skip */
      }
    }
  } catch (err) {
    logger.warn(`[media] image cache sweep error: ${err}`)
  }
}
