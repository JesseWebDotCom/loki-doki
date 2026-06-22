// Read-through cache for YouTube artwork — video thumbnails, channel avatars, banners.
//
// The /api/youtube/img proxy fills this lazily: on a miss it fetches the image from
// Google's CDN, writes the bytes to disk under data/yt-image-cache/<urlHash>, records a
// row, and serves it. Subsequent requests serve straight off disk — the browser (and our
// canvas code) never touch Google again, which also sidesteps the avatar-CDN 429s.
//
// Eviction / renewal (runImageCacheMaintenance, on boot + every 24h):
//   • Non-subscribed entries are deleted 24h after they were fetched. Re-viewing the same
//     image just re-fetches it — cheap, and keeps disk from growing without bound.
//   • Subscribed channel artwork (avatars + banners of channels you're subscribed to) is
//     kept and conditionally re-validated every 24h via If-None-Match / If-Modified-Since:
//     304 → bump the check time, 200 → overwrite with the new image. This is the artwork
//     that actually changes; video thumbnails are immutable per id so they aren't renewed.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { eq, and, lt, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { ytImageCache, ytSubscriptions, ytChannelCache } from '@/db/schema'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'

const CACHE_DIR = join(dataDir, 'yt-image-cache')
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

// Only fetch from YouTube's own image hosts — same allow-list the proxy route enforces.
const ALLOWED_HOST = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com|youtube\.com)$/i

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

type Fetched = { data: Buffer; contentType: string; etag: string | null; lastModified: string | null }

// Fetch an image from upstream. With `cond`, sends a conditional request and returns
// 'not-modified' on a 304 so the caller can keep the existing bytes. null = failure.
async function fetchUpstream(url: string, cond?: { etag: string | null; lastModified: string | null }): Promise<Fetched | 'not-modified' | null> {
  const headers: Record<string, string> = {}
  if (cond?.etag) headers['If-None-Match'] = cond.etag
  if (cond?.lastModified) headers['If-Modified-Since'] = cond.lastModified
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (r.status === 304) return 'not-modified'
    if (!r.ok) return null
    return {
      data: Buffer.from(await r.arrayBuffer()),
      contentType: r.headers.get('content-type') ?? 'image/jpeg',
      etag: r.headers.get('etag'),
      lastModified: r.headers.get('last-modified'),
    }
  } catch { return null }
}

// Write bytes to disk (filename = urlHash, extensionless — content-type lives in the row,
// so a type change never orphans an old file) and upsert the row. Preserves `subscribed`.
async function persist(hash: string, url: string, f: Fetched): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(join(CACHE_DIR, hash), f.data)
  const now = new Date()
  await db.insert(ytImageCache).values({
    urlHash: hash, url, filePath: hash, contentType: f.contentType,
    etag: f.etag, lastModified: f.lastModified, subscribed: false,
    sizeBytes: f.data.byteLength, fetchedAt: now, checkedAt: now,
  }).onConflictDoUpdate({
    target: ytImageCache.urlHash,
    set: {
      filePath: hash, contentType: f.contentType, etag: f.etag, lastModified: f.lastModified,
      sizeBytes: f.data.byteLength, fetchedAt: now, checkedAt: now,
    },
  })
}

/** Read-through accessor used by the /img proxy. Serves cached bytes off disk, fetching
 *  and persisting on a miss. Returns null for a forbidden host or an upstream failure. */
export async function getOrFetchImage(rawUrl: string): Promise<{ data: Buffer; contentType: string } | null> {
  let url: URL
  try { url = new URL(rawUrl) } catch { return null }
  if (url.protocol !== 'https:' || !ALLOWED_HOST.test(url.hostname)) return null

  const hash = hashUrl(rawUrl)
  const [row] = await db.select().from(ytImageCache).where(eq(ytImageCache.urlHash, hash)).limit(1)
  if (row?.filePath) {
    const abs = join(CACHE_DIR, row.filePath)
    if (existsSync(abs)) {
      try { return { data: await readFile(abs), contentType: row.contentType ?? 'image/jpeg' } }
      catch { /* file unreadable — fall through and re-fetch */ }
    }
  }

  const fetched = await fetchUpstream(url.toString())
  if (!fetched || fetched === 'not-modified') return null
  await persist(hash, rawUrl, fetched)
  return { data: fetched.data, contentType: fetched.contentType }
}

// ── Maintenance ────────────────────────────────────────────────────────────────

// Mark which cached rows are "subscribed" artwork: the avatars + banners of channels the
// user is subscribed to. These are kept fresh and never evicted; everything else expires.
async function reconcileSubscribed(): Promise<void> {
  const subs = await db.select({ thumb: ytSubscriptions.thumbnailUrl, ext: ytSubscriptions.externalId }).from(ytSubscriptions)
  const protectedUrls = new Set<string>()
  for (const s of subs) if (s.thumb) protectedUrls.add(s.thumb)

  // Avatar + banner URLs cached on the channel page (the high-res header art that the
  // subscription's stored thumbnail often lacks), but only for subscribed channels.
  const subIds = new Set(subs.map(s => s.ext))
  if (subIds.size) {
    for (const c of await db.select().from(ytChannelCache)) {
      if (!subIds.has(c.channelId) || !c.metaJson) continue
      try {
        const m = JSON.parse(c.metaJson) as { thumbnailUrl?: string; bannerUrl?: string }
        if (m.thumbnailUrl) protectedUrls.add(m.thumbnailUrl)
        if (m.bannerUrl) protectedUrls.add(m.bannerUrl)
      } catch { /* malformed cache meta — skip */ }
    }
  }

  const protectedHashes = [...protectedUrls].map(hashUrl)
  // Reset then set: cheaper than diffing, and correct since this runs before renew/evict.
  await db.update(ytImageCache).set({ subscribed: false }).where(eq(ytImageCache.subscribed, true))
  if (protectedHashes.length) {
    await db.update(ytImageCache).set({ subscribed: true }).where(inArray(ytImageCache.urlHash, protectedHashes))
  }
}

// Conditionally re-validate subscribed artwork older than 24h since its last check.
async function renewSubscribed(now: number): Promise<void> {
  const due = await db.select().from(ytImageCache)
    .where(and(eq(ytImageCache.subscribed, true), lt(ytImageCache.checkedAt, new Date(now - TTL_MS))))
  for (const row of due) {
    const res = await fetchUpstream(row.url, { etag: row.etag, lastModified: row.lastModified })
    if (res === 'not-modified') {
      await db.update(ytImageCache).set({ checkedAt: new Date(now) }).where(eq(ytImageCache.urlHash, row.urlHash))
    } else if (res) {
      await persist(row.urlHash, row.url, res)   // overwrites bytes + bumps timestamps; subscribed preserved
    }
    // res === null → upstream hiccup; leave the stale copy and retry next pass.
  }
}

// Delete non-subscribed entries 24h past their fetch, plus any orphaned files on disk.
async function evictExpired(now: number): Promise<void> {
  const stale = await db.select().from(ytImageCache)
    .where(and(eq(ytImageCache.subscribed, false), lt(ytImageCache.fetchedAt, new Date(now - TTL_MS))))
  for (const row of stale) {
    if (row.filePath) { try { await unlink(join(CACHE_DIR, row.filePath)) } catch { /* already gone */ } }
    await db.delete(ytImageCache).where(eq(ytImageCache.urlHash, row.urlHash))
  }
  // Sweep stray files whose row is gone (filename == urlHash, so membership is a direct check).
  const known = new Set((await db.select({ h: ytImageCache.urlHash }).from(ytImageCache)).map(r => r.h))
  for (const f of await readdir(CACHE_DIR).catch(() => [] as string[])) {
    if (!known.has(f)) { try { await unlink(join(CACHE_DIR, f)) } catch { /* race with a write */ } }
  }
}

let _running = false
/** One maintenance pass: reconcile subscribed flags → renew subscribed art → evict stale. */
export async function runImageCacheMaintenance(): Promise<void> {
  if (_running) return
  _running = true
  const now = Date.now()
  try {
    await reconcileSubscribed()
    await renewSubscribed(now)
    await evictExpired(now)
  } catch (err) {
    logger.warn(`[youtube] image cache maintenance error: ${err}`)
  } finally {
    _running = false
  }
}

let _timer: ReturnType<typeof setInterval> | null = null
/** Run maintenance shortly after boot (covers app-open) and every 24h thereafter. */
export function startImageCacheMaintenance(): void {
  if (_timer) return
  setTimeout(() => void runImageCacheMaintenance(), 30_000)
  _timer = setInterval(() => void runImageCacheMaintenance(), TTL_MS)
}
