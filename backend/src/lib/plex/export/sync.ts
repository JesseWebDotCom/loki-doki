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
import { userContentRoot } from '@/lib/plex/export/library'
import { showFolderName, seasonFolderRelPath, episodeFileNames } from '@/lib/plex/export/paths'
import { buildTvShowNfo, buildEpisodeNfo, showNfoHash } from '@/lib/plex/export/nfo'
import { writeShowAssets, writeEpisodeThumb } from '@/lib/plex/export/assets'
import { placeFile } from '@/lib/plex/export/placement'
import { refreshPlexPath } from '@/lib/plex/export/refresh'
import { cutSetHash, hasAnyEnabled } from '@/lib/plex/cut/cutSet'
import { plexCutFormat } from '@/lib/plex/cut/run'
import { computeKeepRanges, type Range } from '@/lib/plex/cut/videoCut'
import { cutAndRenderSrt } from '@/lib/plex/cut/subtitleCut'
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { logger } from '@/lib/logger'

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

async function ensureShow(
  userId: string, firstName: string, channelId: string, channelTitleFallback: string, variant: 'main' | 'shorts',
): Promise<{ id: string; title: string; folderRelPath: string; showDirAbs: string }> {
  const [existing] = await db.select().from(ytPlexShows)
    .where(and(eq(ytPlexShows.userId, userId), eq(ytPlexShows.channelId, channelId), eq(ytPlexShows.variant, variant)))

  // Best-effort channel metadata refresh — a failure here just means we fall back to
  // whatever we already have (or a bare title on first creation), never fatal.
  let meta: { title: string; description: string | null; thumbnailUrl: string | null; bannerUrl: string | null } | null = null
  try {
    const page = await innertubeChannel(channelId, null, 1, 8000, 'videos')
    if (page.meta) meta = page.meta
  } catch { /* best-effort */ }

  const title = meta?.title || channelTitleFallback || channelId
  const folderRelPath = showFolderName(title, variant)
  const root = await userContentRoot(CONTENT_TYPE, userId, firstName)
  const showDirAbs = joinUnderRoot(root, folderRelPath)
  const nowHash = showNfoHash({ title, description: meta?.description ?? null, avatarUrl: meta?.thumbnailUrl ?? null, bannerUrl: meta?.bannerUrl ?? null })
  const now = new Date()

  if (existing) {
    if (existing.nfoHash !== nowHash) {
      await mkdir(showDirAbs, { recursive: true })
      await writeFile(`${showDirAbs}/tvshow.nfo`, buildTvShowNfo({ title, plot: meta?.description ?? '' }))
      await writeShowAssets(showDirAbs, { avatarUrl: meta?.thumbnailUrl ?? null, bannerUrl: meta?.bannerUrl ?? null })
      await db.update(ytPlexShows).set({
        title, nfoHash: nowHash, nfoWrittenAt: now, postersWrittenAt: now, updatedAt: now,
      }).where(eq(ytPlexShows.id, existing.id))
    }
    return { id: existing.id, title: existing.title, folderRelPath: existing.folderRelPath, showDirAbs }
  }

  await mkdir(showDirAbs, { recursive: true })
  await writeFile(`${showDirAbs}/tvshow.nfo`, buildTvShowNfo({ title, plot: meta?.description ?? '' }))
  await writeShowAssets(showDirAbs, { avatarUrl: meta?.thumbnailUrl ?? null, bannerUrl: meta?.bannerUrl ?? null })
  const id = crypto.randomUUID()
  await db.insert(ytPlexShows).values({
    id, userId, channelId, variant, title, folderRelPath,
    nfoHash: nowHash, nfoWrittenAt: now, postersWrittenAt: now, createdAt: now, updatedAt: now,
  })
  return { id, title, folderRelPath, showDirAbs }
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

/** Decide whether the ORIGINAL rendition can be placed as-is, or whether a SponsorBlock cut
 *  is needed first. Returns 'waiting' when a cut is needed but not ready yet — the caller
 *  must have already upserted a 'cutting' episode row before this returns 'waiting' (done
 *  by the caller, not here, since only it knows the show/season/episode-number to write). */
async function resolveRendition(
  userId: string, videoId: string, originalAsset: { id: string; blobHash: string | null }, durationSec: number | null,
): Promise<ResolvedRendition | { waiting: true; cutSetHash: string; enabled: Record<string, boolean> }> {
  const fullRange: Range[] = [{ start: 0, end: durationSec ?? Number.MAX_SAFE_INTEGER }]
  const enabled = await getUserSkipCategories(userId)
  if (!hasAnyEnabled(enabled) || !originalAsset.blobHash) {
    return { blobHash: originalAsset.blobHash!, assetId: originalAsset.id, keepRanges: fullRange, cutFormatKey: null }
  }
  const segments = await getSkipSegments(videoId)
  const cutRanges = segments.filter(s => enabled[s.category as keyof typeof enabled] === true)
  if (!cutRanges.length) return { blobHash: originalAsset.blobHash, assetId: originalAsset.id, keepRanges: fullRange, cutFormatKey: null }

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
  if (!video || !video.channelId) return

  const [asset] = await db.select().from(mediaAssets)
    .where(and(eq(mediaAssets.sourceType, 'youtube'), eq(mediaAssets.sourceId, videoId), eq(mediaAssets.kind, 'video'), eq(mediaAssets.status, 'ready')))
  if (!asset?.blobHash) return // not downloaded (as video) yet — nothing to place

  const variant = resolveVariant(video.tab, video.durationSec)
  const seasonYear = video.publishedAt ? new Date(video.publishedAt).getFullYear() : 0

  const show = await ensureShow(userId, user.firstName, video.channelId, video.author, variant)
  const episodeNumber = await resolveEpisodeNumber(show.id, seasonYear, video.publishedAt, videoId)

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

  const sourceAbsPath = await blobAbsPath(rendition.blobHash)
  await placeFile(sourceAbsPath, videoAbsPath)

  await mkdir(dirname(videoAbsPath), { recursive: true })
  await writeFile(joinUnderRoot(seasonDirAbs, names.nfo), buildEpisodeNfo({
    title: video.title, plot: video.description ?? video.summary ?? '', aired: isoDate(video.publishedAt),
    season: seasonYear, episode: episodeNumber,
  }))
  await writeEpisodeThumb(joinUnderRoot(seasonDirAbs, names.thumb), video.thumbnailUrl)

  // Captions: re-time against the SAME keepRanges used for the video (identity when
  // nothing was cut) so they can never drift out of sync with what's actually playing.
  let srtWritten = false
  try {
    const vttPath = await ensureTranscript(videoId, userId, user.firstName)
    if (vttPath) {
      const lang = basename(vttPath).match(/\.([a-zA-Z-]+)\.vtt$/)?.[1] ?? 'en'
      const vtt = await readFile(vttPath, 'utf8')
      const srt = cutAndRenderSrt(vtt, rendition.keepRanges)
      if (srt.trim()) {
        await writeFile(joinUnderRoot(seasonDirAbs, names.srt(lang)), srt)
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

  const contentTypeStorageLocationId = await getContentTypeStorageLocationId(CONTENT_TYPE)
  const plexSeasonPath = await toPlexPath(contentTypeStorageLocationId, seasonDirAbs)
  if (plexSeasonPath) {
    await refreshPlexPath(section.plexSectionKey, plexSeasonPath)
    await db.update(ytPlexEpisodes).set({ plexRefreshedAt: new Date() }).where(and(eq(ytPlexEpisodes.userId, userId), eq(ytPlexEpisodes.videoId, videoId)))
  } else {
    logger.warn(`[plex-export] no Plex path mapping for youtube storage location — placed file but could not trigger a targeted refresh`)
  }
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
    if (section?.plexSectionKey) {
      const contentTypeStorageLocationId = await getContentTypeStorageLocationId(CONTENT_TYPE)
      const plexPath = await toPlexPath(contentTypeStorageLocationId, dirname(videoAbsPath))
      if (plexPath) await refreshPlexPath(section.plexSectionKey, plexPath)
    }
  }
  await db.delete(ytPlexEpisodes).where(eq(ytPlexEpisodes.id, ep.id))
}
