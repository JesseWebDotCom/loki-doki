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
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'

const CACHE_DIR = join(dataDir, 'image-cache')
const FETCH_TIMEOUT_MS = 10_000
const MAX_IMAGE_BYTES = 16 * 1024 * 1024 // skip absurdly large responses (banners/posters are KBs)
const MAX_CACHE_BYTES = 512 * 1024 * 1024 // 512 MB ceiling, swept down on boot + daily

// ── SSRF guard ──────────────────────────────────────────────────────────────────
// Block any IP that could reach the host's own network instead of the public internet.
function isPrivateIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const o = ip.split('.').map(Number)
    if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return true
    const [a, b] = o as [number, number, number, number]
    if (a === 0 || a === 10 || a === 127) return true // this-network, private, loopback
    if (a === 172 && b >= 16 && b <= 31) return true // private
    if (a === 192 && b === 168) return true // private
    if (a === 169 && b === 254) return true // link-local (incl. 169.254.169.254 metadata)
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // multicast / reserved
    return false
  }
  if (v === 6) {
    const lc = ip.toLowerCase()
    if (lc === '::1' || lc === '::') return true // loopback / unspecified
    if (lc.startsWith('fe80') || lc.startsWith('fc') || lc.startsWith('fd')) return true // link-local / ULA
    // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4.
    const mapped = lc.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIp(mapped[1]!)
    return false
  }
  return true // not a parseable IP → refuse
}

// True only if the URL is http(s) and every resolved address is publicly routable.
async function isSafePublicUrl(rawUrl: string): Promise<boolean> {
  let u: URL
  try { u = new URL(rawUrl) } catch { return false }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const host = u.hostname
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  if (isIP(host)) return !isPrivateIp(host)
  try {
    const addrs = await lookup(host, { all: true })
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address))
  } catch {
    return false
  }
}

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

/** Read-through accessor for the /api/img proxy. Returns null for an unsafe host, an
 *  oversized/non-image response, or any upstream failure. */
// Negative-cache TTL: 7 days. CoverArtArchive 404s are stable (art either exists or doesn't).
const NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function getOrFetchProxyImage(rawUrl: string): Promise<{ data: Buffer; contentType: string } | null> {
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

  if (!(await isSafePublicUrl(rawUrl))) return null

  const markMissing = async () => {
    try { await mkdir(CACHE_DIR, { recursive: true }); await writeFile(missingPath, '') } catch {}
  }

  try {
    const res = await fetch(rawUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LokiDoki/1.0)', Accept: 'image/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) { await markMissing(); return null }
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
