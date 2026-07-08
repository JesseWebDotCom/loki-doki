// Orchestrates placing ONE video into ONE user's Plex tree, including the SponsorBlock cut
// decision: use the original rendition when nothing needs cutting, else wait on (or kick
// off) a shared plex-cut job and re-enter once it's ready. Also handles removal.

import { eq, and } from 'drizzle-orm'
import { readFile, readdir } from 'node:fs/promises'
import { db } from '@/db'
import { ytPlexShows, ytPlexEpisodes, ytVideos, mediaAssets, plexLibrarySections, users } from '@/db/schema'
import { blobAbsPath } from '@/lib/content/store'
import { innertubeChannel } from '@/lib/youtube/innertube'
import { getUserSkipCategories, getSkipSegments } from '@/lib/youtube/sponsorblock'
import { ensureTranscript } from '@/lib/youtube/download'
import { toPlexPath, joinUnderRoot, getContentTypeStorageLocationId } from '@/lib/storage/contentRoots'
import { getPlexConnection, type PlexConnection } from '@/lib/plex/index'
import { userContentRoot } from '@/lib/plex/export/library'
import { showFolderName, seasonFolderRelPath, episodeFileNames } from '@/lib/plex/export/paths'
import { buildTvShowNfo, buildEpisodeNfo, showNfoHash } from '@/lib/plex/export/nfo'
import { sanitizeDescription } from '@/lib/plex/export/sanitize'
import { writeShowAssets, writeSeasonAssets, writeEpisodeThumb } from '@/lib/plex/export/assets'
import { placeVideoWithMetadata } from '@/lib/plex/export/placement'
import { refreshPlexPath } from '@/lib/plex/export/refresh'
import { cutSetHash, hasAnyEnabled } from '@/lib/plex/cut/cutSet'
import { plexCutFormat } from '@/lib/plex/cut/run'
import { computeKeepRanges, type Range } from '@/lib/plex/cut/videoCut'
import { cutAndRenderSrt } from '@/lib/plex/cut/subtitleCut'
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { ffprobeBin } from '@/lib/ffmpeg'
import { logger } from '@/lib/logger'

/** Container duration in seconds via ffprobe (same probe media/enhance.ts uses); 0 when
 *  unreadable — which makes writeEpisodeThumb skip rather than publish a badge-less thumb. */
export function probeDurationSec(path: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    p.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    p.on('close', () => { const n = parseFloat(out.trim()); resolve(Number.isFinite(n) && n > 0 ? n : 0) })
    p.on('error', () => resolve(0))
  })
}

const CONTENT_TYPE = 'youtube'

function isoDate(ms: number | null): string | null {
  if (!ms) return null
  return new Date(ms).toISOString().slice(0, 10)
}

/** 'shorts' when known from the InnerTube tab; legacy/unknown rows fall back to the existing
 *  durationSec<=90 heuristic used elsewhere in this codebase (routes/youtube.ts). */
function resolveVariant(tab: string | null, durationSec: number | null): 'main' | 'shorts' {
  if (tab === 'shorts') return 'shorts'
  if (tab === 'videos' || tab === 'live') return 'main'
  return durationSec != null && durationSec <= 90 ? 'shorts' : 'main'
}

/** Season "names" are just the tab the videos came from (Videos/Shorts/Live) rather than
 *  the raw calendar year — the year is still what groups episodes into folders/NFO
 *  <season> numbers (unrelated to and unaffected by this), this only changes the DISPLAY
 *  text Plex shows for that season when "Use season titles" is enabled. Shorts already get
 *  their own separate show (a different variant), so in practice a show only ever has one
 *  of these per season instance; kept as a lookup (not a fixed variant-wide constant) so a
 *  season 0 "no publish date known" episode still gets a sensible label instead of "0".
 */
function seasonDisplayName(variant: 'main' | 'shorts', seasonYear: number): string {
  if (seasonYear === 0) return 'Specials'
  return variant === 'shorts' ? 'Shorts' : 'Videos'
}

const PLEX_TIMEOUT_MS = 15_000

/** BCP-47-ish caption code ("en", "en-US", "pt-BR") → the ISO 639-2 code MP4 language atoms
 *  want. Unmapped languages return 'und' — which Plex shows as "Unknown", same as untagged,
 *  so an exotic language never regresses below the status quo. */
const ISO639_2: Record<string, string> = {
  en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', nl: 'nld', sv: 'swe',
  no: 'nor', da: 'dan', fi: 'fin', pl: 'pol', ru: 'rus', uk: 'ukr', cs: 'ces', tr: 'tur',
  ar: 'ara', he: 'heb', hi: 'hin', ja: 'jpn', ko: 'kor', zh: 'zho', vi: 'vie', th: 'tha', id: 'ind',
}
export function toIso639_2(captionLang: string): string {
  return ISO639_2[captionLang.toLowerCase().split('-')[0] ?? ''] ?? 'und'
}

async function resolveShowRatingKey(conn: PlexConnection, sectionKey: string, showTitle: string): Promise<string | null> {
  try {
    const res = await fetch(`${conn.baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/all?type=2&X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(PLEX_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = await res.json().catch(() => null) as { MediaContainer?: { Metadata?: Array<{ ratingKey?: string; title?: string }> } } | null
    return data?.MediaContainer?.Metadata?.find(m => m.title === showTitle)?.ratingKey ?? null
  } catch { return null }
}

/** Sets the show's description directly on the Plex item via the same metadata-edit API
 *  Plex's own "Edit Metadata" UI uses (verified live 2026-07) — bypasses the whole NFO/agent
 *  question entirely: the active "Plex TV Series" agent never reads our tvshow.nfo's <plot>
 *  (confirmed live — refresh metadata, still blank), but a direct field edit doesn't care
 *  what agent is active. `.locked=1` stops Plex from ever overwriting it via a future
 *  (re-)match. Best-effort — the show might not be scanned into Plex's index yet (its
 *  season/episode file was just placed and refresh is async), so a short retry covers the
 *  common case without blocking the whole sync on it. */
export async function setShowDescription(sectionKey: string, showTitle: string, description: string): Promise<void> {
  if (!description) return
  const conn = await getPlexConnection()
  if (!conn) return
  // A brand-new show isn't in Plex's index until a section scan finds it — and on a fresh
  // section that's the DEBOUNCED full scan (30s trailing, see refresh.ts), not the instant
  // targeted refresh. The old 3×1.5s retry window always expired first, so every show in a
  // recreated library ended up with no description (confirmed live). Fire-and-forget caller,
  // so a patient window is free: ~3 minutes at 15s spacing.
  for (let attempt = 0; attempt < 12; attempt++) {
    const ratingKey = await resolveShowRatingKey(conn, sectionKey, showTitle)
    if (ratingKey) {
      const params = new URLSearchParams({ type: '2', id: ratingKey, 'summary.value': description, 'summary.locked': '1', 'X-Plex-Token': conn.token })
      try {
        const res = await fetch(`${conn.baseUrl}/library/metadata/${encodeURIComponent(ratingKey)}?${params.toString()}`, {
          method: 'PUT', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(PLEX_TIMEOUT_MS),
        })
        if (res.ok) return
      } catch (err) {
        logger.warn(`[plex-export] setShowDescription PUT failed for "${showTitle}": ${err}`)
      }
    }
    if (attempt < 11) await new Promise(r => setTimeout(r, 15_000))
  }
  logger.warn(`[plex-export] gave up setting description for "${showTitle}" — show never appeared in Plex's index`)
}

// ── Show ratings ──────────────────────────────────────────────────────────────
// Both display natively in Plex clients: contentRating as the age badge next to the
// title, audienceRating as the score. Set via the same metadata-edit API as the show
// description, locked so a future agent match can't overwrite them.

const CONTENT_RATINGS = ['TV-MA', 'TV-14', 'TV-PG', 'TV-G', 'TV-Y7', 'TV-Y'] as const

/** TV Parental Guidelines rating for a channel, inferred by the local fast model from the
 *  channel's name/about text and its exported video titles. Best-effort: null (skip) when
 *  the model is unavailable or answers something unparseable. */
async function inferShowContentRating(title: string, description: string | null, sampleTitles: string[]): Promise<string | null> {
  try {
    const { ollamaChat } = await import('@/llm/ollama')
    const { getFastModel } = await import('@/lib/models')
    const model = await getFastModel()
    const prompt =
      `Assign a US TV Parental Guidelines rating to this YouTube channel based on its typical content.\n`
      + `Channel: ${title}\n`
      + (description ? `About: ${description.slice(0, 500)}\n` : '')
      + (sampleTitles.length ? `Recent videos: ${sampleTitles.slice(0, 8).join(' | ')}\n` : '')
      + `Consider profanity, violence, sexual content, and mature themes typical for the channel.\n`
      + `Answer with EXACTLY one of: TV-Y, TV-Y7, TV-G, TV-PG, TV-14, TV-MA. No other text.`
    const res = await ollamaChat(model, [{ role: 'user', content: prompt }], undefined, { temperature: 0, num_predict: 10 })
    const out = (res.message?.content ?? '').toUpperCase()
    // Ordered strictest-first so "TV-14" can't be matched inside a stray "TV-1" etc.
    return CONTENT_RATINGS.find(r => out.includes(r)) ?? null
  } catch { return null }
}

/** 0–10 audience score from the mean like/view ratio of the show's exported videos.
 *  YouTube stopped exposing dislikes, so the classic likes/(likes+dislikes) isn't possible;
 *  likes-per-view is the honest signal left. ~8% saturates the scale (an exceptionally
 *  loved video), ~4% (a typical healthy ratio) lands at 5.0. */
async function computeAudienceRating(showId: string): Promise<number | null> {
  const rows = await db.select({ likes: ytVideos.likeCount, views: ytVideos.viewCount })
    .from(ytPlexEpisodes)
    .innerJoin(ytVideos, eq(ytVideos.videoId, ytPlexEpisodes.videoId))
    .where(eq(ytPlexEpisodes.showId, showId))
  const ratios = rows.filter(r => r.likes != null && r.views != null && r.views > 0).map(r => r.likes! / r.views!)
  if (!ratios.length) return null
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length
  return Math.round(Math.min(1, avg / 0.08) * 100) / 10
}

// Re-running the LLM + rating PUTs on every episode of a burst placement is waste — once
// per show per backend session is plenty (episode-count drift barely moves the average).
const ratingsAppliedAt = new Map<string, number>()
const RATINGS_REAPPLY_MS = 6 * 60 * 60 * 1000

async function applyShowRatings(sectionKey: string, showTitle: string, showId: string, channelId: string): Promise<void> {
  const last = ratingsAppliedAt.get(showId)
  if (last && Date.now() - last < RATINGS_REAPPLY_MS) return
  ratingsAppliedAt.set(showId, Date.now())
  const conn = await getPlexConnection()
  if (!conn) return
  const description = await innertubeChannel(channelId, null, 1, 8000, 'videos')
    .then(p => p.meta?.description ?? null).catch(() => null)
  const sampleTitles = (await db.select({ t: ytVideos.title })
    .from(ytPlexEpisodes).innerJoin(ytVideos, eq(ytVideos.videoId, ytPlexEpisodes.videoId))
    .where(eq(ytPlexEpisodes.showId, showId)).limit(8)).map(r => r.t)
  const [contentRating, audience] = await Promise.all([
    inferShowContentRating(showTitle, description, sampleTitles),
    computeAudienceRating(showId),
  ])
  if (!contentRating && audience == null) { ratingsAppliedAt.delete(showId); return }
  // Same patient window as setShowDescription — the show only enters Plex's index when
  // the debounced full-section scan finds it.
  for (let attempt = 0; attempt < 12; attempt++) {
    const ratingKey = await resolveShowRatingKey(conn, sectionKey, showTitle)
    if (ratingKey) {
      const params = new URLSearchParams({ type: '2', id: ratingKey, 'X-Plex-Token': conn.token })
      if (contentRating) { params.set('contentRating.value', contentRating); params.set('contentRating.locked', '1') }
      if (audience != null) { params.set('audienceRating.value', String(audience)); params.set('audienceRating.locked', '1') }
      try {
        const res = await fetch(`${conn.baseUrl}/library/metadata/${encodeURIComponent(ratingKey)}?${params.toString()}`, {
          method: 'PUT', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(PLEX_TIMEOUT_MS),
        })
        if (res.ok) return
      } catch (err) {
        logger.warn(`[plex-export] applyShowRatings PUT failed for "${showTitle}": ${err}`)
      }
    }
    if (attempt < 11) await new Promise(r => setTimeout(r, 15_000))
  }
  ratingsAppliedAt.delete(showId)  // never landed — let a later sync try again
}

async function ensureShow(
  userId: string, firstName: string, channelId: string, channelTitleFallback: string, variant: 'main' | 'shorts', seasonYear: number, sectionKey: string,
): Promise<{ id: string; title: string; folderRelPath: string; showDirAbs: string }> {
  const [existing] = await db.select().from(ytPlexShows)
    .where(and(eq(ytPlexShows.userId, userId), eq(ytPlexShows.channelId, channelId), eq(ytPlexShows.variant, variant)))

  // Best-effort channel metadata refresh — a failure here just means we fall back to
  // whatever we already have (or a bare title on first creation), never fatal.
  let meta: { title: string; description: string | null; thumbnailUrl: string | null; bannerUrl: string | null } | null = null
  try {
    const page = await innertubeChannel(channelId, null, 1, 8000, 'videos')
    // Sanitize right at the source — a channel "About" description can carry the same
    // sponsor-link risk as a video description (confirmed live: a raw affiliate URL
    // triggered an app-install prompt in a Plex client). Every downstream use of
    // meta.description in this function inherits the fix from this one spot.
    if (page.meta) meta = { ...page.meta, description: page.meta.description ? sanitizeDescription(page.meta.description) : page.meta.description }
  } catch { /* best-effort */ }

  const title = meta?.title || channelTitleFallback || channelId
  const folderRelPath = showFolderName(title, variant)
  const root = await userContentRoot(CONTENT_TYPE, userId, firstName)
  const showDirAbs = joinUnderRoot(root, folderRelPath)
  const now = new Date()

  const showId = existing?.id ?? crypto.randomUUID()
  const knownSeasonYears = existing
    ? [...new Set([...(await db.select({ y: ytPlexEpisodes.seasonYear }).from(ytPlexEpisodes).where(eq(ytPlexEpisodes.showId, existing.id))).map(r => r.y), seasonYear])]
    : [seasonYear]
  const namedSeasons = knownSeasonYears.map(y => ({ number: y, name: seasonDisplayName(variant, y) }))
  const nowHash = showNfoHash({ title, description: meta?.description ?? null, avatarUrl: meta?.thumbnailUrl ?? null, bannerUrl: meta?.bannerUrl ?? null, seasonYears: knownSeasonYears })

  if (existing && existing.nfoHash === nowHash) {
    return { id: existing.id, title: existing.title, folderRelPath: existing.folderRelPath, showDirAbs }
  }

  await mkdir(showDirAbs, { recursive: true })
  await writeFile(`${showDirAbs}/tvshow.nfo`, buildTvShowNfo({ title, plot: meta?.description ?? '', namedSeasons }))
  await writeShowAssets(showDirAbs, { avatarUrl: meta?.thumbnailUrl ?? null, bannerUrl: meta?.bannerUrl ?? null })
  await writeSeasonAssets(showDirAbs, seasonYear, seasonDisplayName(variant, seasonYear), channelId, { bannerUrl: meta?.bannerUrl ?? null })
  // Fire-and-forget: the show may not be scanned into Plex's index yet on a first-ever
  // placement (setShowDescription retries a few times to cover the common case), and this
  // shouldn't hold up the rest of the sync either way.
  if (meta?.description) void setShowDescription(sectionKey, title, meta.description)
  if (existing) {
    await db.update(ytPlexShows).set({ title, nfoHash: nowHash, nfoWrittenAt: now, postersWrittenAt: now, updatedAt: now }).where(eq(ytPlexShows.id, existing.id))
  } else {
    await db.insert(ytPlexShows).values({
      id: showId, userId, channelId, variant, title, folderRelPath,
      nfoHash: nowHash, nfoWrittenAt: now, postersWrittenAt: now, createdAt: now, updatedAt: now,
    })
  }
  return { id: showId, title, folderRelPath, showDirAbs }
}

/** MMDD-derived, bumped on same-day collision within (showId, seasonYear) — see schema.ts
 *  ytPlexEpisodes.episodeNumber for why this needs to be a real column, not re-derived from
 *  filenames. `excludeVideoId` lets a re-sync of the SAME video reuse its own number instead
 *  of perpetually incrementing every time it's re-placed. */
async function resolveEpisodeNumber(showId: string, seasonYear: number, publishedAt: number | null, excludeVideoId: string): Promise<number> {
  const [own] = await db.select({ episodeNumber: ytPlexEpisodes.episodeNumber }).from(ytPlexEpisodes)
    .where(and(eq(ytPlexEpisodes.showId, showId), eq(ytPlexEpisodes.videoId, excludeVideoId)))
  if (own) return own.episodeNumber

  const base = publishedAt ? Number(`${String(new Date(publishedAt).getMonth() + 1).padStart(2, '0')}${String(new Date(publishedAt).getDate()).padStart(2, '0')}`) : 1
  const siblings = await db.select({ episodeNumber: ytPlexEpisodes.episodeNumber }).from(ytPlexEpisodes)
    .where(and(eq(ytPlexEpisodes.showId, showId), eq(ytPlexEpisodes.seasonYear, seasonYear)))
  const used = new Set(siblings.map(s => s.episodeNumber))
  let n = base
  while (used.has(n)) n++
  return n
}

interface ResolvedRendition { blobHash: string; assetId: string; keepRanges: Range[]; cutFormatKey: string | null }

/** No-cut placements prefer the enhanced rendition when the user opted in and it's current
 *  (same height-freshness proxy as resolvePlaybackBlob in lib/youtube/assets.ts). Cut and
 *  enhance are NEVER combined — cut wins: the SponsorBlock cut is produced from the base
 *  rendition, and enhancing a cut output would need a derived-of-derived pipeline for
 *  marginal gain. */
async function preferEnhancedAsset(
  userId: string, videoId: string, original: { id: string; blobHash: string | null; height: number | null },
): Promise<{ id: string; blobHash: string | null }> {
  const { shouldEnhanceFor } = await import('@/lib/media/enhancePolicy')
  if (!(await shouldEnhanceFor(userId, 'youtube'))) return original
  const [enh] = await db.select().from(mediaAssets).where(and(
    eq(mediaAssets.sourceType, 'youtube'), eq(mediaAssets.sourceId, videoId),
    eq(mediaAssets.kind, 'video'), eq(mediaAssets.format, 'mp4:enhanced'), eq(mediaAssets.status, 'ready'),
  )).limit(1)
  if (enh?.blobHash && enh.height === original.height) return { id: enh.id, blobHash: enh.blobHash }
  return original
}

/** Decide whether the ORIGINAL rendition can be placed as-is, or whether a SponsorBlock cut
 *  is needed first. Returns 'waiting' when a cut is needed but not ready yet — the caller
 *  must have already upserted a 'cutting' episode row before this returns 'waiting' (done
 *  by the caller, not here, since only it knows the show/season/episode-number to write). */
async function resolveRendition(
  userId: string, videoId: string, originalAsset: { id: string; blobHash: string | null; height: number | null }, durationSec: number | null,
): Promise<ResolvedRendition | { waiting: true; cutSetHash: string; enabled: Record<string, boolean> }> {
  const fullRange: Range[] = [{ start: 0, end: durationSec ?? Number.MAX_SAFE_INTEGER }]
  const enabled = await getUserSkipCategories(userId)
  if (!hasAnyEnabled(enabled) || !originalAsset.blobHash) {
    const chosen = await preferEnhancedAsset(userId, videoId, originalAsset)
    return { blobHash: chosen.blobHash!, assetId: chosen.id, keepRanges: fullRange, cutFormatKey: null }
  }
  const segments = await getSkipSegments(videoId)
  const cutRanges = segments.filter(s => enabled[s.category as keyof typeof enabled] === true)
  if (!cutRanges.length) {
    const chosen = await preferEnhancedAsset(userId, videoId, originalAsset)
    return { blobHash: chosen.blobHash!, assetId: chosen.id, keepRanges: fullRange, cutFormatKey: null }
  }

  const hash = cutSetHash(enabled)
  const format = plexCutFormat(hash)
  const [cutAsset] = await db.select().from(mediaAssets)
    .where(and(eq(mediaAssets.sourceType, 'youtube'), eq(mediaAssets.sourceId, videoId), eq(mediaAssets.kind, 'video'), eq(mediaAssets.format, format)))
  if (cutAsset?.status === 'ready' && cutAsset.blobHash) {
    return { blobHash: cutAsset.blobHash, assetId: cutAsset.id, keepRanges: computeKeepRanges(cutRanges, durationSec ?? 0), cutFormatKey: format }
  }
  return { waiting: true, cutSetHash: hash, enabled }
}

/** Place (or re-place) one video into its owning user's Plex tree. No-ops gracefully if
 *  that user has no ready 'youtube' Plex library, or the video has no ready downloaded
 *  rendition yet — both are legitimate states, not errors. */
export async function syncVideoToPlex(userId: string, videoId: string): Promise<void> {
  const [section] = await db.select().from(plexLibrarySections)
    .where(and(eq(plexLibrarySections.userId, userId), eq(plexLibrarySections.contentType, CONTENT_TYPE)))
  if (!section || section.status !== 'ready' || !section.plexSectionKey) return

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) return

  const [video] = await db.select().from(ytVideos).where(eq(ytVideos.videoId, videoId)).limit(1)
  if (!video) return
  // channelId lands via async metadata enrichment moments after save, and the asset-ready
  // fanout can beat it. Throw (the job retries with backoff) rather than silently returning
  // ✓ — confirmed live 2026-07-06: 11 fresh downloads "synced" with zero episodes placed,
  // and nothing ever re-fired them.
  if (!video.channelId) throw new Error(`video ${videoId} has no channelId yet (metadata enrichment pending) — will retry`)
  // Prefer the "Smart Description" (promotional content already stripped by an LLM pass —
  // see summarize.ts) when the background enrichment has generated one. Sanitize the raw
  // fallbacks regardless, for the window right after a fresh save before that job finishes —
  // confirmed live: a raw sponsor URL in a real YouTube description came through as a
  // tappable link in a Plex client and triggered an app-install/deep-link prompt.
  const episodePlot = video.descriptionClean
    ?? (video.description ? sanitizeDescription(video.description) : null)
    ?? (video.summary ? sanitizeDescription(video.summary) : null)
    ?? ''

  const [asset] = await db.select().from(mediaAssets)
    .where(and(eq(mediaAssets.sourceType, 'youtube'), eq(mediaAssets.sourceId, videoId), eq(mediaAssets.kind, 'video'), eq(mediaAssets.status, 'ready')))
  if (!asset?.blobHash) return // not downloaded (as video) yet — nothing to place

  const variant = resolveVariant(video.tab, video.durationSec)
  const seasonYear = video.publishedAt ? new Date(video.publishedAt).getFullYear() : 0

  const show = await ensureShow(userId, user.firstName, video.channelId, video.author, variant, seasonYear, section.plexSectionKey)
  const episodeNumber = await resolveEpisodeNumber(show.id, seasonYear, video.publishedAt, videoId)

  // Library policy pre-check: under 'recent' mode a video that wouldn't make the show's
  // newest-N cut is skipped before any cut/placement work — placing it just to have
  // enforcement remove it again would churn the tree (and burn a SponsorBlock cut encode).
  const { wouldMakeRecentCut, enforceLibraryPolicy } = await import('@/lib/plex/export/policy')
  if (!(await wouldMakeRecentCut(section, { table: 'youtube', showId: show.id, videoId, seasonYear, episodeNumber }))) {
    return
  }

  const rendition = await resolveRendition(userId, videoId, asset, video.durationSec)
  if ('waiting' in rendition) {
    const now = new Date()
    const [existingEp] = await db.select().from(ytPlexEpisodes).where(and(eq(ytPlexEpisodes.userId, userId), eq(ytPlexEpisodes.videoId, videoId)))
    const cutFields = { showId: show.id, seasonYear, episodeNumber, cutCategoriesHash: rendition.cutSetHash, status: 'cutting' as const, error: null, updatedAt: now }
    if (existingEp) await db.update(ytPlexEpisodes).set(cutFields).where(eq(ytPlexEpisodes.id, existingEp.id))
    else await db.insert(ytPlexEpisodes).values({ id: crypto.randomUUID(), userId, videoId, ...cutFields, createdAt: now })
    const { enqueuePlexCut } = await import('@/lib/downloadJobs')
    await enqueuePlexCut(videoId, rendition.cutSetHash, rendition.enabled)
    return // fanOutReady() in the plex-cut runner re-enqueues plex-sync once it's ready
  }

  const names = episodeFileNames(show.title ?? video.author, seasonYear, episodeNumber, videoId, video.title)
  const root = await userContentRoot(CONTENT_TYPE, userId, user.firstName)
  const seasonRel = seasonFolderRelPath(show.title ?? video.author, variant, seasonYear)
  const seasonDirAbs = joinUnderRoot(root, seasonRel)
  const videoAbsPath = joinUnderRoot(seasonDirAbs, names.video)

  // Transcript first: its language is the only audio-language signal we have (YouTube's
  // API doesn't expose one reliably), and the placement remux wants it for the audio
  // stream's language atom — untagged audio lists as "Unknown" in Plex's stream picker.
  let vttPath: string | null = null
  let captionLang = 'en'
  try {
    vttPath = await ensureTranscript(videoId, userId, user.firstName)
    if (vttPath) captionLang = basename(vttPath).match(/\.([a-zA-Z-]+)\.vtt$/)?.[1] ?? 'en'
  } catch { /* transcript is optional; language falls back below */ }

  const sourceAbsPath = await blobAbsPath(rendition.blobHash)
  await placeVideoWithMetadata(sourceAbsPath, videoAbsPath, { title: video.title, plot: episodePlot, audioLang: toIso639_2(captionLang) })

  await mkdir(dirname(videoAbsPath), { recursive: true })
  await writeFile(joinUnderRoot(seasonDirAbs, names.nfo), buildEpisodeNfo({
    title: video.title, plot: episodePlot, aired: isoDate(video.publishedAt),
    season: seasonYear, episode: episodeNumber,
  }))
  // A row saved outside a subscription feed may have no stored thumbnail URL, but YouTube
  // thumbnail URLs are deterministic from the videoId — fall back through the standard
  // sizes (maxres only exists for some videos; hqdefault always does). writeEpisodeThumb
  // refuses to publish a badge-less thumb, so resolve a real duration first: DB value,
  // else ffprobe the just-placed file (its container always knows).
  const badgeDurationSec = video.durationSec ?? await probeDurationSec(videoAbsPath)
  if (badgeDurationSec && !video.durationSec) {
    await db.update(ytVideos).set({ durationSec: Math.round(badgeDurationSec) }).where(eq(ytVideos.videoId, videoId))
  }
  for (const cand of [video.thumbnailUrl, `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`]) {
    if (cand && await writeEpisodeThumb(joinUnderRoot(seasonDirAbs, names.thumb), cand, badgeDurationSec)) break
  }

  // Captions: re-time against the SAME keepRanges used for the video (identity when
  // nothing was cut) so they can never drift out of sync with what's actually playing.
  // (vttPath/captionLang resolved above, before placement, for the audio-language atom.)
  let srtWritten = false
  try {
    if (vttPath) {
      const vtt = await readFile(vttPath, 'utf8')
      const srt = cutAndRenderSrt(vtt, rendition.keepRanges)
      if (srt.trim()) {
        await writeFile(joinUnderRoot(seasonDirAbs, names.srt(captionLang)), srt)
        srtWritten = true
      }
    }
  } catch (err) {
    logger.warn(`[plex-export] caption re-time failed for ${videoId}: ${err}`) // best-effort, never blocks placement
  }

  const now = new Date()
  const relPath = joinUnderRoot(seasonRel, names.video)
  const [existingEp] = await db.select().from(ytPlexEpisodes).where(and(eq(ytPlexEpisodes.userId, userId), eq(ytPlexEpisodes.videoId, videoId)))
  const readyFields = {
    showId: show.id, seasonYear, episodeNumber, sourceAssetId: asset.id, cutFormatKey: rendition.cutFormatKey,
    relPath, nfoWrittenAt: now, thumbWrittenAt: now, srtWrittenAt: srtWritten ? now : null,
    status: 'ready' as const, error: null, updatedAt: now,
  }
  if (existingEp) await db.update(ytPlexEpisodes).set(readyFields).where(eq(ytPlexEpisodes.id, existingEp.id))
  else await db.insert(ytPlexEpisodes).values({ id: crypto.randomUUID(), userId, videoId, ...readyFields, createdAt: now })

  // Fire-and-forget like setShowDescription; runs after the episode upsert so the show's
  // sample titles / like-ratio pool includes this video. Internally debounced per show.
  void applyShowRatings(section.plexSectionKey, show.title ?? video.author, show.id, video.channelId)

  const contentTypeStorageLocationId = await getContentTypeStorageLocationId(CONTENT_TYPE)
  const plexSeasonPath = await toPlexPath(contentTypeStorageLocationId, seasonDirAbs)
  if (plexSeasonPath) {
    await refreshPlexPath(section.plexSectionKey, plexSeasonPath)
    await db.update(ytPlexEpisodes).set({ plexRefreshedAt: new Date() }).where(and(eq(ytPlexEpisodes.userId, userId), eq(ytPlexEpisodes.videoId, videoId)))
  } else {
    logger.warn(`[plex-export] no Plex path mapping for youtube storage location — placed file but could not trigger a targeted refresh`)
  }

  // Trim the tree if this placement pushed the show past its recent-N window.
  await enforceLibraryPolicy(userId, CONTENT_TYPE, show.id)
}

/** Remove a video from a user's Plex tree (unsave / auto-prune). Deletes the placed file +
 *  its NFO/thumb/srt siblings and fires a refresh so Plex's episode count drops immediately
 *  instead of waiting for its own periodic scan to notice the file is gone. */
export async function removeVideoFromPlex(userId: string, videoId: string): Promise<void> {
  const [ep] = await db.select().from(ytPlexEpisodes).where(and(eq(ytPlexEpisodes.userId, userId), eq(ytPlexEpisodes.videoId, videoId)))
  if (!ep?.relPath) {
    if (ep) await db.delete(ytPlexEpisodes).where(eq(ytPlexEpisodes.id, ep.id))
    return
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  const [section] = await db.select().from(plexLibrarySections)
    .where(and(eq(plexLibrarySections.userId, userId), eq(plexLibrarySections.contentType, CONTENT_TYPE)))
  if (user) {
    const root = await userContentRoot(CONTENT_TYPE, userId, user.firstName)
    const videoAbsPath = joinUnderRoot(root, ep.relPath)
    const seasonDir = dirname(videoAbsPath)
    const stemName = basename(videoAbsPath).replace(/\.mp4$/, '')
    // Delete every sidecar sharing this episode's stem (.mp4/.nfo/-thumb.jpg/.<lang>.srt) —
    // scanning the folder rather than guessing suffixes covers whatever language(s) got
    // written without needing to persist the caption language anywhere.
    try {
      const entries = await readdir(seasonDir)
      for (const name of entries) {
        if (name === stemName || name.startsWith(`${stemName}.`) || name.startsWith(`${stemName}-`)) {
          await rm(joinUnderRoot(seasonDir, name), { force: true }).catch(() => {})
        }
      }
    } catch { /* season folder already gone */ }
    // A show whose last episode was just removed (unsave, auto-prune, or a rule like the
    // Topic-channel exclusion above stripping every episode it had) would otherwise linger
    // in Plex as an empty ghost entry — confirmed live: exactly this happened for 3 shows
    // after excluding music "Topic" channels. Clean up the whole show, not just the episode,
    // when nothing's left under it.
    const showDirAbs = dirname(seasonDir)
    let showEmptied = false
    try {
      const remaining = await readdir(seasonDir)
      if (remaining.length === 0) {
        await rm(seasonDir, { recursive: true, force: true })
      }
    } catch { /* already gone */ }
    try {
      const showEntries = await readdir(showDirAbs)
      const hasSeasonContent = showEntries.some(name => name.startsWith('Season '))
      if (!hasSeasonContent) {
        await rm(showDirAbs, { recursive: true, force: true })
        showEmptied = true
      }
    } catch { /* already gone */ }
    if (showEmptied) await db.delete(ytPlexShows).where(eq(ytPlexShows.id, ep.showId))

    if (section?.plexSectionKey) {
      const contentTypeStorageLocationId = await getContentTypeStorageLocationId(CONTENT_TYPE)
      const refreshPath = showEmptied ? root : dirname(videoAbsPath)
      const plexPath = await toPlexPath(contentTypeStorageLocationId, refreshPath)
      if (plexPath) await refreshPlexPath(section.plexSectionKey, plexPath)
    }
  }
  await db.delete(ytPlexEpisodes).where(eq(ytPlexEpisodes.id, ep.id))
}
