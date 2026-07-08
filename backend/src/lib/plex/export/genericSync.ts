// The non-YouTube twin of sync.ts: places ONE hub video (tiktok/vimeo/reddit) or Studio
// video ('mine') into ONE user's per-source Plex tree, and handles removal. Deliberately
// simpler than the YouTube path — no SponsorBlock cuts, no shorts variants, no InnerTube —
// but reuses every source-agnostic module (paths/nfo/assets/placement/refresh) so both
// exporters produce byte-identical tree conventions.
//
// Tracking lives in video_plex_shows / video_plex_episodes (see schema.ts for why the
// yt_plex_* tables were not generalized instead).

import { eq, and } from 'drizzle-orm'
import { readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, basename } from 'node:path'
import { db } from '@/db'
import {
  videoPlexShows, videoPlexEpisodes, videoSaves, videoItems, videoFollows,
  studioMedia, mediaAssets, plexLibrarySections, users,
} from '@/db/schema'
import { blobAbsPath } from '@/lib/content/store'
import { toPlexPath, joinUnderRoot, getContentTypeStorageLocationId } from '@/lib/storage/contentRoots'
import { userContentRoot } from '@/lib/plex/export/library'
import { isGenericExportSource, type GenericExportSource } from '@/lib/plex/export/contentTypes'
import { showFolderName, seasonFolderRelPath, episodeFileNames } from '@/lib/plex/export/paths'
import { buildTvShowNfo, buildEpisodeNfo, showNfoHash } from '@/lib/plex/export/nfo'
import { sanitizeDescription } from '@/lib/plex/export/sanitize'
import { writeShowAssets, writeSeasonAssets, writeEpisodeThumb } from '@/lib/plex/export/assets'
import { placeVideoWithMetadata } from '@/lib/plex/export/placement'
import { refreshPlexPath } from '@/lib/plex/export/refresh'
import { setShowDescription, toIso639_2, probeDurationSec } from '@/lib/plex/export/sync'
import { cutAndRenderSrt } from '@/lib/plex/cut/subtitleCut'
import { ENHANCED_FORMAT } from '@/lib/media/enhanceJob'
import { getProvider } from '@/lib/videos/registry'
import { logger } from '@/lib/logger'

function isoDate(ms: number | null): string | null {
  if (!ms) return null
  return new Date(ms).toISOString().slice(0, 10)
}

interface ExportCreator {
  /** Stable per-source identity: follow externalId / subreddit / owner userId for mine. */
  key: string
  title: string
  description: string | null
  avatarUrl: string | null
  bannerUrl: string | null
}

interface ExportMeta {
  title: string
  plot: string
  publishedAtMs: number | null
  durationSec: number | null
  thumbnailUrl: string | null
  creator: ExportCreator
  /** Raw WebVTT when the platform exposes captions cheaply (Vimeo); null otherwise. */
  captionsVtt: string | null
  captionLang: string
}

/** 'r/AskReddit' → 'r-AskReddit'. sanitizeFilename would strip the '/' anyway, but doing it
 *  explicitly keeps the folder name deterministic AND visually distinct from a creator that
 *  happens to be literally named "AskReddit" on another source. */
function normalizeRedditTitle(title: string): string {
  return title.replace(/^r\//i, 'r-')
}

/** Best-effort creator enrichment via the provider — network, so only called when the show
 *  doesn't exist yet (first placement for this creator). Afterwards the cheap follow/item
 *  fields drive the nfoHash and nothing re-fetches. */
async function enrichCreator(source: string, creatorKey: string, base: ExportCreator): Promise<ExportCreator> {
  const provider = getProvider(source)
  if (!provider?.getCreator) return base
  try {
    const { creator } = await provider.getCreator(creatorKey)
    return {
      key: base.key,
      title: base.title || creator.name,
      description: creator.description ? sanitizeDescription(creator.description) : base.description,
      avatarUrl: creator.avatarUrl ?? base.avatarUrl,
      bannerUrl: creator.bannerUrl ?? base.bannerUrl,
    }
  } catch { return base }
}

/** Everything the placement needs to know about one video, resolved per source. Null when
 *  the video legitimately isn't exportable (no save row / no studio row / audio-only). */
async function resolveExportMeta(userId: string, source: GenericExportSource, videoId: string): Promise<ExportMeta | null> {
  if (source === 'mine') {
    const [row] = await db.select().from(studioMedia).where(eq(studioMedia.id, videoId)).limit(1)
    if (!row || row.kind !== 'video' || row.status !== 'ready' || !row.assetId) return null
    // The video lands in `userId`'s library, but the SHOW belongs to the video's OWNER —
    // a shared studio video appears under the sharer's name in everyone's My Videos.
    const [owner] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1)
    if (!owner) return null
    return {
      title: row.title || 'Untitled',
      plot: '',
      publishedAtMs: row.createdAt.getTime(),
      durationSec: row.durationSec != null ? Math.round(row.durationSec) : null,
      thumbnailUrl: null,   // studio media has no thumbnail URL; Plex frame-grabs instead
      creator: { key: row.userId, title: owner.firstName, description: null, avatarUrl: null, bannerUrl: null },
      captionsVtt: null,
      captionLang: 'en',
    }
  }

  const [save] = await db.select().from(videoSaves)
    .where(and(eq(videoSaves.userId, userId), eq(videoSaves.source, source), eq(videoSaves.videoId, videoId), eq(videoSaves.kind, 'video')))
    .limit(1)
  if (!save) return null

  const [item] = await db.select().from(videoItems)
    .where(and(eq(videoItems.source, source), eq(videoItems.externalId, videoId)))
    .limit(1)
  const follow = item?.followId
    ? (await db.select().from(videoFollows).where(eq(videoFollows.id, item.followId)).limit(1))[0]
    : undefined

  // Creator identity precedence: the follow row (stable id + curated title/avatar), else the
  // feed item's creator fields, else the save's display name alone (still a valid show — a
  // one-off save of an unfollowed creator).
  let creator: ExportCreator
  if (follow) {
    creator = {
      key: follow.externalId,
      title: follow.title || follow.externalId,
      description: follow.description ? sanitizeDescription(follow.description) : null,
      avatarUrl: follow.thumbnailUrl,
      bannerUrl: null,
    }
  } else if (item?.creatorId || item?.creatorName) {
    creator = { key: item.creatorId ?? item.creatorName!, title: item.creatorName ?? item.creatorId!, description: null, avatarUrl: null, bannerUrl: null }
  } else {
    creator = { key: save.creatorName ?? 'unknown', title: save.creatorName ?? 'Unknown Creator', description: null, avatarUrl: null, bannerUrl: null }
  }
  if (source === 'reddit') creator = { ...creator, title: normalizeRedditTitle(creator.title), key: normalizeRedditTitle(creator.key) }

  // Captions: only Vimeo exposes them cheaply (platform API WebVTT). Best-effort.
  let captionsVtt: string | null = null
  if (source === 'vimeo') {
    try { captionsVtt = (await getProvider('vimeo')?.getCaptions?.(videoId)) ?? null } catch { /* optional */ }
  }

  return {
    title: save.title || videoId,
    plot: '',   // hub items carry no long description worth exporting; sanitized if that changes
    publishedAtMs: item?.publishedAt ? item.publishedAt.getTime() : null,
    durationSec: save.durationSec ?? item?.durationSec ?? null,
    thumbnailUrl: save.thumbnailUrl ?? item?.thumbnailUrl ?? null,
    creator,
    captionsVtt,
    captionLang: 'en',
  }
}

/** Base rendition = the shared mp4 video asset; prefers the enhanced rendition when this
 *  user opted in and it's current (same height-freshness proxy as resolvePlaybackBlob in
 *  lib/youtube/assets.ts — a stale lower-res enhanced rendition is never placed). */
async function resolveGenericRendition(
  userId: string, source: GenericExportSource, videoId: string,
): Promise<{ assetId: string; blobHash: string } | null> {
  let base: { id: string; blobHash: string | null; height: number | null } | undefined
  if (source === 'mine') {
    const [row] = await db.select().from(studioMedia).where(eq(studioMedia.id, videoId)).limit(1)
    if (!row?.assetId) return null
    const [asset] = await db.select().from(mediaAssets)
      .where(and(eq(mediaAssets.id, row.assetId), eq(mediaAssets.status, 'ready')))
      .limit(1)
    base = asset
  } else {
    const [asset] = await db.select().from(mediaAssets)
      .where(and(eq(mediaAssets.sourceType, source), eq(mediaAssets.sourceId, videoId), eq(mediaAssets.kind, 'video'), eq(mediaAssets.format, 'mp4'), eq(mediaAssets.status, 'ready')))
      .limit(1)
    base = asset
  }
  if (!base?.blobHash) return null

  if (source !== 'mine') {
    const { shouldEnhanceFor } = await import('@/lib/media/enhancePolicy')
    if (await shouldEnhanceFor(userId, source)) {
      const [enh] = await db.select().from(mediaAssets)
        .where(and(eq(mediaAssets.sourceType, source), eq(mediaAssets.sourceId, videoId), eq(mediaAssets.kind, 'video'), eq(mediaAssets.format, ENHANCED_FORMAT), eq(mediaAssets.status, 'ready')))
        .limit(1)
      if (enh?.blobHash && enh.height === base.height) return { assetId: enh.id, blobHash: enh.blobHash }
    }
  }
  return { assetId: base.id, blobHash: base.blobHash }
}

async function ensureGenericShow(
  userId: string, firstName: string, source: GenericExportSource, creatorIn: ExportCreator, seasonYear: number, sectionKey: string,
): Promise<{ id: string; title: string; folderRelPath: string; showDirAbs: string }> {
  const [existing] = await db.select().from(videoPlexShows)
    .where(and(eq(videoPlexShows.userId, userId), eq(videoPlexShows.source, source), eq(videoPlexShows.creatorKey, creatorIn.key)))

  // Network enrichment only on first creation — see enrichCreator. 'mine' shows are
  // household members, nothing to enrich.
  const creator = existing || source === 'mine' ? creatorIn : await enrichCreator(source, creatorIn.key, creatorIn)

  const title = existing?.title && creator.title === creatorIn.title ? existing.title : creator.title
  const folderRelPath = showFolderName(title, 'main')
  const root = await userContentRoot(source, userId, firstName)
  const showDirAbs = joinUnderRoot(root, folderRelPath)
  const now = new Date()

  const showId = existing?.id ?? crypto.randomUUID()
  const knownSeasonYears = existing
    ? [...new Set([...(await db.select({ y: videoPlexEpisodes.seasonYear }).from(videoPlexEpisodes).where(eq(videoPlexEpisodes.showId, existing.id))).map(r => r.y), seasonYear])]
    : [seasonYear]
  const seasonLabel = (y: number) => (y === 0 ? 'Specials' : 'Videos')
  const namedSeasons = knownSeasonYears.map(y => ({ number: y, name: seasonLabel(y) }))
  const nowHash = showNfoHash({ title, description: creator.description, avatarUrl: creator.avatarUrl, bannerUrl: creator.bannerUrl, seasonYears: knownSeasonYears })

  if (existing && existing.nfoHash === nowHash) {
    return { id: existing.id, title: existing.title, folderRelPath: existing.folderRelPath, showDirAbs }
  }

  await mkdir(showDirAbs, { recursive: true })
  await writeFile(`${showDirAbs}/tvshow.nfo`, buildTvShowNfo({ title, plot: creator.description ?? '', namedSeasons }))
  await writeShowAssets(showDirAbs, { avatarUrl: creator.avatarUrl, bannerUrl: creator.bannerUrl })
  await writeSeasonAssets(showDirAbs, seasonYear, seasonLabel(seasonYear), creator.key, { bannerUrl: creator.bannerUrl })
  if (creator.description) void setShowDescription(sectionKey, title, creator.description)

  if (existing) {
    await db.update(videoPlexShows).set({ title, nfoHash: nowHash, nfoWrittenAt: now, postersWrittenAt: now, updatedAt: now }).where(eq(videoPlexShows.id, existing.id))
  } else {
    await db.insert(videoPlexShows).values({
      id: showId, userId, source, creatorKey: creator.key, title, folderRelPath,
      nfoHash: nowHash, nfoWrittenAt: now, postersWrittenAt: now, createdAt: now, updatedAt: now,
    })
  }
  return { id: showId, title, folderRelPath, showDirAbs }
}

/** Same MMDD + same-day-collision scheme as the YouTube exporter (see ytPlexEpisodes.
 *  episodeNumber) — a re-sync of the SAME video reuses its own number. */
async function resolveGenericEpisodeNumber(showId: string, seasonYear: number, publishedAtMs: number | null, excludeVideoId: string): Promise<number> {
  const [own] = await db.select({ episodeNumber: videoPlexEpisodes.episodeNumber }).from(videoPlexEpisodes)
    .where(and(eq(videoPlexEpisodes.showId, showId), eq(videoPlexEpisodes.videoId, excludeVideoId)))
  if (own) return own.episodeNumber

  const base = publishedAtMs ? Number(`${String(new Date(publishedAtMs).getMonth() + 1).padStart(2, '0')}${String(new Date(publishedAtMs).getDate()).padStart(2, '0')}`) : 1
  const siblings = await db.select({ episodeNumber: videoPlexEpisodes.episodeNumber }).from(videoPlexEpisodes)
    .where(and(eq(videoPlexEpisodes.showId, showId), eq(videoPlexEpisodes.seasonYear, seasonYear)))
  const used = new Set(siblings.map(s => s.episodeNumber))
  let n = base
  while (used.has(n)) n++
  return n
}

/** Place (or re-place) one hub/studio video into a user's per-source Plex tree. No-ops
 *  gracefully when the user has no ready library for this source or the video has no ready
 *  rendition yet — both legitimate states. */
export async function syncGenericVideoToPlex(userId: string, source: string, videoId: string): Promise<void> {
  if (!isGenericExportSource(source)) {
    logger.warn(`[plex-export] plex-sync add for unknown source "${source}" — skipped`)
    return
  }
  const [section] = await db.select().from(plexLibrarySections)
    .where(and(eq(plexLibrarySections.userId, userId), eq(plexLibrarySections.contentType, source)))
  if (!section || section.status !== 'ready' || !section.plexSectionKey) return

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  if (!user) return

  const meta = await resolveExportMeta(userId, source, videoId)
  if (!meta) return   // unsaved / non-video / studio row gone — nothing to place

  const rendition = await resolveGenericRendition(userId, source, videoId)
  if (!rendition) return   // not downloaded yet — completion fan-out will re-enqueue

  const seasonYear = meta.publishedAtMs ? new Date(meta.publishedAtMs).getFullYear() : 0
  const show = await ensureGenericShow(userId, user.firstName, source, meta.creator, seasonYear, section.plexSectionKey)
  const episodeNumber = await resolveGenericEpisodeNumber(show.id, seasonYear, meta.publishedAtMs, videoId)

  // Library policy pre-check: under 'recent' mode a video that wouldn't make the newest-N
  // cut for its show is skipped outright — placing it just to have enforcement remove it
  // again would churn the tree (and a stray late 'add' job could otherwise resurrect a
  // policy-trimmed episode).
  const { wouldMakeRecentCut, enforceLibraryPolicy } = await import('@/lib/plex/export/policy')
  if (!(await wouldMakeRecentCut(section, { table: 'generic', showId: show.id, videoId, seasonYear, episodeNumber }))) {
    return
  }

  const [existingEp] = await db.select().from(videoPlexEpisodes)
    .where(and(eq(videoPlexEpisodes.userId, userId), eq(videoPlexEpisodes.source, source), eq(videoPlexEpisodes.videoId, videoId)))

  const names = episodeFileNames(show.title, seasonYear, episodeNumber, videoId, meta.title)
  const root = await userContentRoot(source, userId, user.firstName)
  const seasonRel = seasonFolderRelPath(show.title, 'main', seasonYear)
  const seasonDirAbs = joinUnderRoot(root, seasonRel)
  const videoAbsPath = joinUnderRoot(seasonDirAbs, names.video)
  const relPath = joinUnderRoot(seasonRel, names.video)

  // Idempotency: already placed from this exact rendition and the file is still there.
  if (existingEp?.status === 'ready' && existingEp.relPath === relPath
    && existingEp.sourceAssetId === rendition.assetId && existsSync(videoAbsPath)) return

  const sourceAbsPath = await blobAbsPath(rendition.blobHash)
  await placeVideoWithMetadata(sourceAbsPath, videoAbsPath, { title: meta.title, plot: meta.plot, audioLang: toIso639_2(meta.captionLang) })

  await mkdir(dirname(videoAbsPath), { recursive: true })
  await writeFile(joinUnderRoot(seasonDirAbs, names.nfo), buildEpisodeNfo({
    title: meta.title, plot: meta.plot, aired: isoDate(meta.publishedAtMs),
    season: seasonYear, episode: episodeNumber,
  }))

  // Thumb needs a real duration for its badge (writeEpisodeThumb refuses badge-less thumbs);
  // fall back to probing the placed file when the row didn't know it.
  const badgeDurationSec = meta.durationSec ?? await probeDurationSec(videoAbsPath)
  const thumbWritten = meta.thumbnailUrl
    ? await writeEpisodeThumb(joinUnderRoot(seasonDirAbs, names.thumb), meta.thumbnailUrl, badgeDurationSec)
    : false

  let srtWritten = false
  try {
    if (meta.captionsVtt) {
      // Identity keep-range: no cutting on the generic path — this is a plain VTT→SRT render.
      const srt = cutAndRenderSrt(meta.captionsVtt, [{ start: 0, end: Number.MAX_SAFE_INTEGER }])
      if (srt.trim()) {
        await writeFile(joinUnderRoot(seasonDirAbs, names.srt(meta.captionLang)), srt)
        srtWritten = true
      }
    }
  } catch (err) {
    logger.warn(`[plex-export] caption render failed for ${source}:${videoId}: ${err}`)
  }

  const now = new Date()
  const readyFields = {
    showId: show.id, seasonYear, episodeNumber, sourceAssetId: rendition.assetId,
    relPath, nfoWrittenAt: now, thumbWrittenAt: thumbWritten ? now : null, srtWrittenAt: srtWritten ? now : null,
    status: 'ready' as const, error: null, updatedAt: now,
  }
  if (existingEp) await db.update(videoPlexEpisodes).set(readyFields).where(eq(videoPlexEpisodes.id, existingEp.id))
  else await db.insert(videoPlexEpisodes).values({ id: crypto.randomUUID(), userId, source, videoId, ...readyFields, createdAt: now })

  const storageLocationId = await getContentTypeStorageLocationId(source)
  const plexSeasonPath = await toPlexPath(storageLocationId, seasonDirAbs)
  if (plexSeasonPath) {
    await refreshPlexPath(section.plexSectionKey, plexSeasonPath)
    await db.update(videoPlexEpisodes).set({ plexRefreshedAt: new Date() })
      .where(and(eq(videoPlexEpisodes.userId, userId), eq(videoPlexEpisodes.source, source), eq(videoPlexEpisodes.videoId, videoId)))
  } else {
    logger.warn(`[plex-export] no Plex path mapping for ${source} storage location — placed file but could not trigger a targeted refresh`)
  }

  // Trim the tree if this placement pushed the show past its recent-N window.
  await enforceLibraryPolicy(userId, source, show.id)
}

/** Remove a video from a user's per-source Plex tree. PLACEMENT-ONLY: deletes the placed
 *  file + sidecars and the tracking row, cleans emptied season/show folders — never touches
 *  video_saves/studio_media (save deletion belongs to the callers that own it: unsave,
 *  auto-prune, the watched sweep). */
export async function removeGenericVideoFromPlex(userId: string, source: string, videoId: string): Promise<void> {
  if (!isGenericExportSource(source)) return
  const [ep] = await db.select().from(videoPlexEpisodes)
    .where(and(eq(videoPlexEpisodes.userId, userId), eq(videoPlexEpisodes.source, source), eq(videoPlexEpisodes.videoId, videoId)))
  if (!ep?.relPath) {
    if (ep) await db.delete(videoPlexEpisodes).where(eq(videoPlexEpisodes.id, ep.id))
    return
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1)
  const [section] = await db.select().from(plexLibrarySections)
    .where(and(eq(plexLibrarySections.userId, userId), eq(plexLibrarySections.contentType, source)))
  if (user) {
    const root = await userContentRoot(source, userId, user.firstName)
    const videoAbsPath = joinUnderRoot(root, ep.relPath)
    const seasonDir = dirname(videoAbsPath)
    const stemName = basename(videoAbsPath).replace(/\.mp4$/, '')
    // Delete every sidecar sharing this episode's stem — same folder-scan approach as the
    // YouTube exporter so caption languages never need persisting.
    try {
      const entries = await readdir(seasonDir)
      for (const name of entries) {
        if (name === stemName || name.startsWith(`${stemName}.`) || name.startsWith(`${stemName}-`)) {
          await rm(joinUnderRoot(seasonDir, name), { force: true }).catch(() => {})
        }
      }
    } catch { /* season folder already gone */ }
    const showDirAbs = dirname(seasonDir)
    let showEmptied = false
    try {
      const remaining = await readdir(seasonDir)
      if (remaining.length === 0) await rm(seasonDir, { recursive: true, force: true })
    } catch { /* already gone */ }
    try {
      const showEntries = await readdir(showDirAbs)
      const hasSeasonContent = showEntries.some(name => name.startsWith('Season '))
      if (!hasSeasonContent) {
        await rm(showDirAbs, { recursive: true, force: true })
        showEmptied = true
      }
    } catch { /* already gone */ }
    if (showEmptied) await db.delete(videoPlexShows).where(eq(videoPlexShows.id, ep.showId))

    if (section?.plexSectionKey) {
      const storageLocationId = await getContentTypeStorageLocationId(source)
      const refreshPath = showEmptied ? root : dirname(videoAbsPath)
      const plexPath = await toPlexPath(storageLocationId, refreshPath)
      if (plexPath) await refreshPlexPath(section.plexSectionKey, plexPath)
    }
  }
  await db.delete(videoPlexEpisodes).where(eq(videoPlexEpisodes.id, ep.id))
}
