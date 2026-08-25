// App-wide read-through image proxy. Every remote image the UI renders that ISN'T already
// covered by a specialised cache (YouTube's subscription-pinned imageCache, the media
// poster cache) flows through /api/img?u=<url> and lands here. Three reasons to never let
// the browser hit a publisher/CDN directly:
//   • privacy — the user's IP + Referer never reach the upstream host (this is a private hub);
//   • reliability — signed/hotlink-protected CDNs (e.g. Guardian's i.guim.co.uk) and
//     rate-limited ones are fetched once, server-side, then served same-origin;
//   • caching — bytes are kept on disk so repeat views are free.
//
// Unlike the media proxy this serves ARBITRARY hosts (news/RSS images come from any CDN),
// so the SSRF guard isn't a host allowlist — it's a deny: https/http only, and the resolved
// IP must be public (no loopback/private/link-local, blocking metadata endpoints + LAN).
// Layout mirrors the media cache: bytes at data/image-cache/<sha256>, content-type in a
// <sha256>.t sidecar, bounded by a periodic size sweep (no per-URL renewal).

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'
import { safeFetch } from '@/lib/ssrfGuard'

const CACHE_DIR = join(dataDir, 'image-cache')
const FETCH_TIMEOUT_MS = 10_000
const MAX_IMAGE_BYTES = 16 * 1024 * 1024 // skip absurdly large responses (banners/posters are KBs)
const MAX_CACHE_BYTES = 512 * 1024 * 1024 // 512 MB ceiling, swept down on boot + daily

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

/** Read-through accessor for the /api/img proxy. Returns null for an unsafe host, an
 *  oversized/non-image response, or any upstream failure. */
// Negative-cache TTL: 7 days. CoverArtArchive 404s are stable (art either exists or doesn't).
const NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

// In-flight dedupe, mirroring the YouTube image cache's. It matters now that the server
// warms card art in the background (warmProxyImages): without it, a warm and the client's
// own request for the same uncached URL both fetch it upstream.
const inflight = new Map<string, Promise<{ data: Buffer; contentType: string } | null>>()

export function getOrFetchProxyImage(rawUrl: string): Promise<{ data: Buffer; contentType: string } | null> {
  const pending = inflight.get(rawUrl)
  if (pending) return pending
  const p = fetchProxyImage(rawUrl)
  inflight.set(rawUrl, p)
  void p.finally(() => inflight.delete(rawUrl))
  return p
}

async function fetchProxyImage(rawUrl: string): Promise<{ data: Buffer; contentType: string } | null> {
  const hash = hashUrl(rawUrl)
  const bytesPath = join(CACHE_DIR, hash)
  const typePath = join(CACHE_DIR, `${hash}.t`)
  const missingPath = join(CACHE_DIR, `${hash}.x`)

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

  // Negative cache: skip upstream fetch if we recently got a 404/error for this URL.
  if (existsSync(missingPath)) {
    try {
      const s = await stat(missingPath)
      if (Date.now() - s.mtimeMs < NEGATIVE_CACHE_TTL_MS) return null
      // Expired — fall through and retry
      await unlink(missingPath).catch(() => {})
    } catch { return null }
  }

  const markMissing = async () => {
    try { await mkdir(CACHE_DIR, { recursive: true }); await writeFile(missingPath, '') } catch {}
  }

  try {
    // safeFetch re-validates the destination on every redirect hop (not just the
    // initial URL), so a public URL that 302s to a LAN/metadata address is rejected —
    // a plain fetch(..., { redirect: 'follow' }) would silently follow it.
    const res = await safeFetch(
      rawUrl,
      { headers: { 'User-Agent': 'MaiPaiHome/3.0 (self-hosted home hub; https://github.com/getmaipai)', Accept: 'image/*' } },
      { timeoutMs: FETCH_TIMEOUT_MS },
    )
    if (!res.ok) {
      // Only PERMANENT misses go in the negative cache. Transient failures (429 rate
      // limits - Wikimedia throttles bursts - plus 5xx) must retry on the next request;
      // negative-caching a 429 for 7 days made every artist photo vanish for a week.
      if (res.status === 404 || res.status === 410 || res.status === 403) await markMissing()
      return null
    }
    const contentType = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim()
    if (!contentType.startsWith('image/')) { await markMissing(); return null }
    const buf = await res.arrayBuffer()
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) { await markMissing(); return null }
    const data = Buffer.from(buf)
    await mkdir(CACHE_DIR, { recursive: true })
    await Promise.all([writeFile(bytesPath, data), writeFile(typePath, contentType)])
    return { data, contentType }
  } catch {
    return null
  }
}

/** Read-through accessor with an optional width hint (?w=): serves a bucketed webp
 *  downscale rendered beside the original, or the original when resizing isn't
 *  possible (no vips, animated/vector source, bad width). */
export async function getOrFetchProxyImageResized(rawUrl: string, w: string | undefined): Promise<{ data: Buffer; contentType: string } | null> {
  const { bucketFor, getResizedVariant, readCachedVariant } = await import('@/lib/imageResize')
  const bucket = bucketFor(w)
  const srcPath = join(CACHE_DIR, hashUrl(rawUrl))
  // Warm path first: an already-rendered variant is served without touching the original,
  // which on a card grid is the difference between reading 40 downscales and reading 40
  // downscales PLUS their 40 full-size originals.
  if (bucket) {
    const hit = await readCachedVariant(srcPath, bucket)
    if (hit) return hit
  }
  const orig = await getOrFetchProxyImage(rawUrl)
  if (!orig) return null
  if (!bucket) return orig
  const variant = await getResizedVariant(srcPath, orig.contentType, bucket)
  return variant ?? orig
}

// Background warming ─────────────────────────────────────────────────────────────
// How many warms run at once. Small on purpose: a warm must never crowd out the real
// requests the user's browser is making at the same time.
const WARM_CONCURRENCY = 3

/** Pre-fill the disk cache (and the `w` variant) for images a client is ABOUT to ask for,
 *  so the first view is a disk hit instead of a live fetch to some CDN while the card is
 *  already on screen. Already-cached URLs cost one existsSync. Fire and forget: this
 *  never throws and its result is not awaited by request handlers. */
export async function warmProxyImages(urls: (string | null | undefined)[], w?: string): Promise<void> {
  const list = urls.filter((u): u is string => !!u)
  for (let i = 0; i < list.length; i += WARM_CONCURRENCY) {
    await Promise.allSettled(
      list.slice(i, i + WARM_CONCURRENCY).map((u) => getOrFetchProxyImageResized(u, w)),
    )
  }
}

/** Bound the cache: if total bytes exceed the ceiling, delete oldest files first. */
export async function imageCacheSweep(): Promise<void> {
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
    logger.warn(`[img] image cache sweep error: ${err}`)
  }
}
