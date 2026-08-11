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
//     that actually changes; video thumbnails are immutable per id so they don't NEED
//     renewing (a 304 every 24h is just a bit of harmless overhead for them).
//   • A genuinely saved video's own thumbnail reuses this same "subscribed" protection —
//     it should live exactly as long as the video/Plex export do, not silently disappear
//     and require a live re-fetch a day later (see reconcileSubscribed()).

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { eq, and, lt, inArray, isNotNull } from 'drizzle-orm'
import { db } from '@/db'
import { ytImageCache, ytSubscriptions, ytChannelCache, ytVideos, ytDownloads } from '@/db/schema'
import { dataDir } from '@/lib/download'
import { logger } from '@/lib/logger'
import { PLACEHOLDER_MAX_BYTES } from '@/lib/youtube/thumbnail'

const CACHE_DIR = join(dataDir, 'yt-image-cache')
const TTL_MS = 24 * 60 * 60 * 1000
// Video thumbnails (i.ytimg.com/vi/<id>/…) are immutable per id — evicting them after 24h
// just forces a pointless re-fetch of identical bytes on the next view, so they get a month.
const VIDEO_THUMB_TTL_MS = 30 * 24 * 60 * 60 * 1000
const isVideoThumbUrl = (url: string): boolean => url.includes('i.ytimg.com/vi/')
// Channel avatars + banners (yt3.ggpht.com / yt3.googleusercontent.com). These are the
// images the UI paints on EVERY card, and they are the ones Google's CDN 429s when
// hotlinked, so evicting them 24h after they were fetched just guaranteed a cold,
// rate-limited re-fetch the next time you scrolled a feed. Keep them for a month like
// video thumbnails (they are a few KB each at the avatar sizes we request) and refresh
// them in the background instead, so a channel that rebrands still updates.
const CHANNEL_ART_TTL_MS = 30 * 24 * 60 * 60 * 1000
const isChannelArtUrl = (url: string): boolean => url.includes('ggpht.com') || url.includes('googleusercontent.com')
// Background refresh for non-subscribed channel art: revalidate once a week, bounded per
// pass so a big browsing history can't turn one maintenance run into thousands of
// requests. Each is conditional, so an unchanged avatar costs a 304 and no bytes.
const CHANNEL_ART_RENEW_MS = 7 * 24 * 60 * 60 * 1000
const CHANNEL_ART_RENEW_BATCH = 200
const FETCH_TIMEOUT_MS = 10_000

// Only fetch from YouTube's own image hosts — same allow-list the proxy route enforces.
const ALLOWED_HOST = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com|youtube\.com)$/i

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

// Sizes Google's avatar CDN serves directly via the URL's `=sNNN` segment.
const AVATAR_SIZES = [48, 96, 176, 288, 480, 800] as const

/** Rewrite a Google channel-avatar URL's `=sNNN` size segment to the smallest size that
 *  covers `w` device pixels. YouTube hands us avatars at up to 900px square and the UI
 *  paints them into 20-32px circles, so asking the CDN for the right size beats
 *  downloading the original and downscaling it here (and it is the one image the whole
 *  card grid needs at once). Returns null when the URL has no size segment - banners use
 *  `=w<width>-fcrop…` and must not be touched - or when `w` is unusable; the caller then
 *  falls back to the generic vips downscale. */
export function sizedChannelArtUrl(rawUrl: string, w: string | undefined): string | null {
  const want = Number(w)
  if (!Number.isFinite(want) || want <= 0) return null
  if (!/=s\d+(-|$)/.test(rawUrl)) return null
  const size = AVATAR_SIZES.find(s => s >= want) ?? AVATAR_SIZES[AVATAR_SIZES.length - 1]!
  return rawUrl.replace(/=s\d+(?=-|$)/, `=s${size}`)
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

// A grid of thumbnails all missing from a cold cache fires one request per card at once;
// without this, N concurrent requests for the SAME url (e.g. a card + its list-row
// counterpart re-rendering) each redo the full upstream fetch + disk write instead of
// sharing one.
const inflight = new Map<string, Promise<{ data: Buffer; contentType: string } | null>>()

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

  const pending = inflight.get(hash)
  if (pending) return pending
  const p = (async () => {
    let fetched = await fetchUpstream(url.toString())
    // YouTube has no maxresdefault/hq720 for many videos, but i.ytimg.com answers those
    // with HTTP 200 + a ~1.1KB grey placeholder (see lib/youtube/thumbnail.ts) — which
    // would get cached and served as a grey hero forever. Detect it (or a plain 404) and
    // transparently fall back to mqdefault (exists for every video AND is true 16:9 —
    // hqdefault is 4:3 with the letterbox bars baked into the jpeg, which put black
    // bars on covers and cards), cached under the ORIGINAL requested key so every
    // later request stays a plain hit.
    // (oar2 deliberately excluded: a missing shorts vertical should 404 so the
    // client's sharper 16:9 fallback fires instead of a substituted mqdefault.)
    const variant = /^https:\/\/i\.ytimg\.com\/vi\/([\w-]{11})\/(maxresdefault|hq720)\.jpg$/.exec(rawUrl)
    if (variant && (fetched === null || (fetched !== 'not-modified' && fetched.data.byteLength <= PLACEHOLDER_MAX_BYTES))) {
      const fallback = await fetchUpstream(`https://i.ytimg.com/vi/${variant[1]}/mqdefault.jpg`)
      if (fallback && fallback !== 'not-modified') fetched = fallback
    }
    if (!fetched || fetched === 'not-modified') return null
    await persist(hash, rawUrl, fetched)
    return { data: fetched.data, contentType: fetched.contentType }
  })()
  inflight.set(hash, p)
  void p.finally(() => { if (inflight.get(hash) === p) inflight.delete(hash) })
  return p
}

/** Read-through accessor with an optional width hint (?w=), mirroring lib/imageProxy's:
 *  serves a bucketed webp downscale rendered beside the original, or the original when
 *  resizing isn't possible (no vips, animated source, bad width). */
export async function getOrFetchImageResized(rawUrl: string, w: string | undefined): Promise<{ data: Buffer; contentType: string } | null> {
  const { bucketFor, getResizedVariant, readCachedVariant } = await import('@/lib/imageResize')
  const bucket = bucketFor(w)
  const srcPath = join(CACHE_DIR, hashUrl(rawUrl))
  // Warm path first: serve an already-rendered variant without reading (or DB-looking-up)
  // the original. readCachedVariant stats the source too, so an orphaned variant whose
  // original was evicted falls through to the full path instead of being served.
  if (bucket) {
    const hit = await readCachedVariant(srcPath, bucket)
    if (hit) return hit
  }
  const orig = await getOrFetchImage(rawUrl)
  if (!orig) return null
  if (!bucket) return orig
  const variant = await getResizedVariant(srcPath, orig.contentType, bucket)
  return variant ?? orig
}

// ── Background warming ─────────────────────────────────────────────────────────

// Kept small so a warm never crowds out the real requests a browser is making at the
// same time (and never looks like a burst to Google's CDNs).
const WARM_CONCURRENCY = 3

/**
 * Pre-fill the cache for card art a client is ABOUT to request, so the first view is a
 * disk hit rather than a live fetch to Google with the card already on screen.
 *
 * CONTRACT: these must be the exact URLs the UI asks for, or the warm fills keys nobody
 * reads. The frontend builds a video thumbnail as `i.ytimg.com/vi/<id>/mqdefault.jpg`
 * (lib/youtube/format thumbUrl, quality 'mq') - NOT whatever thumbnail URL a feed
 * happened to carry - and requests channel avatars with a width, which this route rewrites
 * to Google's own `=sNNN` size (see sizedChannelArtUrl / lib/img AVATAR_W).
 */
export async function warmYoutubeCardImages(videoIds: string[], avatarUrls: (string | null | undefined)[] = []): Promise<void> {
  // Deduped: an avatar URL with no `=sNNN` segment resolves to the same key at both widths.
  const urls = [...new Set([
    ...videoIds.map((id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`),
    // Both avatar sizes the UI can ask for: cards (AVATAR_W) and headers (AVATAR_W_LARGE).
    ...avatarUrls.flatMap((u) => (u ? ['96', '288'].map((w) => sizedChannelArtUrl(u, w) ?? u) : [])),
  ])]
  for (let i = 0; i < urls.length; i += WARM_CONCURRENCY) {
    await Promise.allSettled(urls.slice(i, i + WARM_CONCURRENCY).map((u) => getOrFetchImage(u)))
  }
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

  // Channel avatars resolved for any library video (yt_videos.channel_thumb is only ever
  // written for saved/Watch-Later/Liked/watched videos — see summarize.ts:ensureChannelThumb).
  // Keep these so the library tabs still show real logos beyond the 24h non-subscribed window.
  for (const v of await db.select({ thumb: ytVideos.channelThumb }).from(ytVideos).where(isNotNull(ytVideos.channelThumb))) {
    if (v.thumb) protectedUrls.add(v.thumb)
  }

  // A genuinely saved video (a real ytDownloads ref, not the app's own speculative
  // prefetch cache-warming) should keep its thumbnail for as long as the video itself
  // exists — the video and Plex export both persist permanently, so a thumbnail silently
  // evicting and needing a live re-fetch 24h later doesn't make sense for it. Excludes
  // prefetch=true rows for the same reason the Plex sync queries do (see sync.ts/routes).
  const savedVideoIds = [...new Set((await db.select({ id: ytDownloads.videoId }).from(ytDownloads)
    .where(and(eq(ytDownloads.status, 'ready'), eq(ytDownloads.prefetch, false)))).map(r => r.id))]
  if (savedVideoIds.length) {
    for (const v of await db.select({ thumb: ytVideos.thumbnailUrl }).from(ytVideos).where(inArray(ytVideos.videoId, savedVideoIds))) {
      if (v.thumb) protectedUrls.add(v.thumb)
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

// Conditionally re-validate non-subscribed channel art that has gone a week without a
// check. Mirrors renewSubscribed, but bounded per pass (CHANNEL_ART_RENEW_BATCH) because
// this set grows with everything you have ever browsed, not with what you subscribed to.
async function renewChannelArt(now: number): Promise<void> {
  const due = (await db.select().from(ytImageCache)
    .where(and(eq(ytImageCache.subscribed, false), lt(ytImageCache.checkedAt, new Date(now - CHANNEL_ART_RENEW_MS)))))
    .filter(r => isChannelArtUrl(r.url))
    .slice(0, CHANNEL_ART_RENEW_BATCH)
  for (const row of due) {
    const res = await fetchUpstream(row.url, { etag: row.etag, lastModified: row.lastModified })
    if (res === 'not-modified') {
      await db.update(ytImageCache).set({ checkedAt: new Date(now) }).where(eq(ytImageCache.urlHash, row.urlHash))
    } else if (res) {
      await persist(row.urlHash, row.url, res)
    }
    // res === null → upstream hiccup (a 429 included); keep the bytes and retry next pass.
  }
}

// Delete non-subscribed entries past their TTL (24h, or 30 days for immutable video
// thumbnails and for channel art — see VIDEO_THUMB_TTL_MS / CHANNEL_ART_TTL_MS), plus
// any orphaned files on disk.
function ttlFor(url: string): number {
  if (isVideoThumbUrl(url)) return VIDEO_THUMB_TTL_MS
  if (isChannelArtUrl(url)) return CHANNEL_ART_TTL_MS
  return TTL_MS
}

async function evictExpired(now: number): Promise<void> {
  const stale = await db.select().from(ytImageCache)
    .where(and(eq(ytImageCache.subscribed, false), lt(ytImageCache.fetchedAt, new Date(now - TTL_MS))))
  for (const row of stale) {
    if (row.fetchedAt.getTime() > now - ttlFor(row.url)) continue
    if (row.filePath) { try { await unlink(join(CACHE_DIR, row.filePath)) } catch { /* already gone */ } }
    await db.delete(ytImageCache).where(eq(ytImageCache.urlHash, row.urlHash))
  }
  // Sweep stray files whose row is gone (filename == urlHash, so membership is a direct
  // check). Resized variants live beside their original as <urlHash>.w<bucket>.webp (see
  // lib/imageResize) — strip that suffix so a live entry's variants aren't swept, while an
  // evicted entry's variants go with it.
  const known = new Set((await db.select({ h: ytImageCache.urlHash }).from(ytImageCache)).map(r => r.h))
  for (const f of await readdir(CACHE_DIR).catch(() => [] as string[])) {
    const base = f.replace(/\.w\d+\.webp$/, '')
    if (!known.has(base)) { try { await unlink(join(CACHE_DIR, f)) } catch { /* race with a write */ } }
  }
}

let _running = false
/** One maintenance pass: reconcile subscribed flags → renew subscribed art → refresh
 *  non-subscribed channel art → evict stale. */
export async function runImageCacheMaintenance(): Promise<void> {
  if (_running) return
  _running = true
  const now = Date.now()
  try {
    await reconcileSubscribed()
    await renewSubscribed(now)
    await renewChannelArt(now)
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
