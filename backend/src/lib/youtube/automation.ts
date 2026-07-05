// Subscription automation: when the feed poller discovers new uploads for a subscription,
// it can (opt-in, per subscription/show) save them offline and/or generate podcast episodes.
//
// All of it is gated by a per-user master pause and is off by default — subscribing alone
// never downloads or generates anything. See feed.ts (the only caller of
// applySubscriptionAutomation) and the /youtube routes that flip the flags.

import { eq, and, inArray } from 'drizzle-orm'
import { unlink } from 'node:fs/promises'
import { db } from '@/db'
import {
  ytSubscriptions, ytVideos, ytDownloads, downloadJobs,
  podcastShows, podcastEpisodes, podcastEpisodeSources, users, userPreferences,
} from '@/db/schema'
import { logger } from '@/lib/logger'
import { getEffectiveCap } from '@/lib/youtube/quality'
import { getAppSetting } from '@/lib/settings'
import { resolveUserPath } from '@/lib/storage/paths'
import { withLock } from '@/lib/content/store'
import { assetFormat, assetLockKey, getOrCreateAsset, assetSatisfies, enqueueAssetJob, releaseAssetsIfOrphaned, type Kind, type AudioFormat } from '@/lib/youtube/assets'

// ── Settings keys ──────────────────────────────────────────────────────────────

/** Per-user master switch (userPreferences). When true, NO automation runs for that
 *  user — feeds still refresh, but nothing is saved or generated. */
export const AUTO_PAUSE_KEY = 'youtube.automation_paused'
/** Global default for the rolling "keep latest N auto-saved videos" cap (appSettings). */
export const AUTO_KEEP_KEY = 'youtube.auto_save_keep'
export const DEFAULT_AUTO_SAVE_KEEP = 10

export async function isAutomationPaused(userId: string): Promise<boolean> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, AUTO_PAUSE_KEY)))
    .limit(1)
  if (!row) return false
  try { return JSON.parse(row.value) === true } catch { return false }
}

export async function setAutomationPaused(userId: string, paused: boolean): Promise<void> {
  const now = new Date()
  await db.insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId, key: AUTO_PAUSE_KEY, value: JSON.stringify(paused), updatedAt: now })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value: JSON.stringify(paused), updatedAt: now } })
}

/** Admin global default for keep-N (per-subscription override wins when set). */
export async function getAutoSaveKeepDefault(): Promise<number> {
  const v = await getAppSetting(AUTO_KEEP_KEY)
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_AUTO_SAVE_KEEP
}

async function getFirstName(userId: string): Promise<string> {
  const [u] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId)).limit(1)
  return u?.firstName ?? 'user'
}

// ── Shared offline-save enqueue (used by manual Save + auto-save) ────────────────

export interface EnqueueSaveOpts {
  userId: string
  videoId: string
  title: string
  kind: 'audio' | 'video'
  maxHeight: number | null
  firstName: string
  audioFormat?: 'm4a' | 'mp3'
  /** True when written by auto-save — marks the row for keep-N pruning eligibility. */
  auto?: boolean
  /** Which app the save came from. Music saves are hidden from the YouTube Saved tab. Default 'youtube'. */
  origin?: 'youtube' | 'music'
}

/** Upsert the per-user ytDownloads REFERENCE and ensure a shared media asset (+ its coalesced
 *  download job) exists for the content. Shared by manual Save and subscription auto-save.
 *
 *  Dedup is the point: two users saving the same video share ONE asset → ONE blob. If a
 *  household member already has the asset at sufficient quality, this returns instantly with
 *  no download (the household's "store-the-max" copy serves everyone). The whole decision runs
 *  under a per-asset lock so concurrent saves can't double-download or race the height math. */
export async function enqueueVideoSave(opts: EnqueueSaveOpts): Promise<{ status: 'queued' | 'already-saved' | 'in-progress'; id: string }> {
  const { userId, videoId, title, kind, maxHeight, firstName: _firstName, audioFormat, auto = false, origin = 'youtube' } = opts
  const format = assetFormat(kind, audioFormat)

  return withLock(assetLockKey(videoId, kind, format), async () => {
    const now = new Date()
    const asset = await getOrCreateAsset(videoId, kind, format)

    // Upsert the user's reference, pointing it at the shared asset.
    const [existing] = await db.select({ id: ytDownloads.id }).from(ytDownloads)
      .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.videoId, videoId), eq(ytDownloads.kind, kind)))
      .limit(1)
    const refId = existing?.id ?? crypto.randomUUID()
    if (!existing) {
      await db.insert(ytDownloads).values({
        id: refId, userId, videoId, title, kind, maxHeight, assetId: asset.id, auto, origin,
        status: 'pending', createdAt: now, updatedAt: now,
      })
    } else {
      // An explicit save promotes a transient prefetch ref into a permanent one (prefetch→false),
      // so it survives the prefetch prune. Don't downgrade a manual save's `auto` flag. Origin only
      // ever upgrades toward 'youtube' (a YouTube save of a music-saved track surfaces it in YouTube;
      // a music save never hides a track the user had saved from YouTube).
      await db.update(ytDownloads)
        .set({ status: 'pending', error: null, maxHeight, assetId: asset.id, prefetch: false, ...(auto ? { auto: true } : {}), ...(origin === 'youtube' ? { origin: 'youtube' as const } : {}), updatedAt: now })
        .where(eq(ytDownloads.id, refId))
    }

    // Dedup hit: the household already holds this at sufficient quality — satisfy instantly.
    if (assetSatisfies(asset, kind, maxHeight)) {
      await db.update(ytDownloads).set({ status: 'ready', sizeBytes: asset.sizeBytes, error: null, updatedAt: now })
        .where(eq(ytDownloads.id, refId))
      // This path bypasses completeAsset()'s fan-out entirely (nothing to download), so it
      // needs its own Plex-export hook — otherwise a dedup-satisfied save never reaches Plex.
      if (kind === 'video') {
        const { enqueuePlexSync } = await import('@/lib/downloadJobs')
        void enqueuePlexSync(userId, videoId, 'add').catch(() => {})
      }
      return { status: 'already-saved', id: refId }
    }

    // Otherwise ensure a (coalesced) download job exists for the asset. The worker recomputes
    // the target height from all live refs, so adding this ref already widened the target.
    const wasActive = asset.status === 'downloading'
    await enqueueAssetJob(asset, `Save "${title || videoId}" (${kind})`)
    return { status: wasActive ? 'in-progress' : 'queued', id: refId }
  })
}

// ── Prefetch cache ──────────────────────────────────────────────────────────────
// A transient, self-evicting download-ahead cache that powers gapless playback (next video,
// audio↔video handoff). A prefetch ref reuses the whole save pipeline but is flagged ephemeral,
// runs at lower priority than user saves, and is bounded by a rolling keep-N prune per user.
const PREFETCH_PRIORITY = 80
const PREFETCH_KEEP = 8

/** Download-ahead a track to disk transiently. Never downgrades an existing real save into a
 *  prefetch ref; never blocks a save (lower job priority). Bounds the cache afterwards. */
export async function enqueuePrefetch(opts: { userId: string; videoId: string; title?: string; kind: Kind; maxHeight?: number | null; audioFormat?: AudioFormat }): Promise<void> {
  const { userId, videoId, title = '', kind, maxHeight = null, audioFormat } = opts
  const format = assetFormat(kind, audioFormat)
  await withLock(assetLockKey(videoId, kind, format), async () => {
    const now = new Date()
    const asset = await getOrCreateAsset(videoId, kind, format)
    const [existing] = await db.select({ id: ytDownloads.id }).from(ytDownloads)
      .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.videoId, videoId), eq(ytDownloads.kind, kind))).limit(1)
    const refId = existing?.id ?? crypto.randomUUID()
    if (!existing) {
      await db.insert(ytDownloads).values({ id: refId, userId, videoId, title, kind, maxHeight, assetId: asset.id, prefetch: true, origin: 'music', status: 'pending', createdAt: now, updatedAt: now })
    } else {
      // Touch updatedAt (LRU) but keep its existing prefetch flag — a real save is never demoted.
      await db.update(ytDownloads).set({ assetId: asset.id, updatedAt: now }).where(eq(ytDownloads.id, refId))
    }
    if (assetSatisfies(asset, kind, maxHeight)) {
      await db.update(ytDownloads).set({ status: 'ready', sizeBytes: asset.sizeBytes, error: null, updatedAt: now }).where(eq(ytDownloads.id, refId))
    } else {
      await enqueueAssetJob(asset, `Prefetch "${title || videoId}" (${kind})`, PREFETCH_PRIORITY)
    }
  })
  await prunePrefetch(userId).catch(() => {})
}

/** Keep only the newest `keep` prefetch refs per user (by last touch); drop the rest + free blobs. */
export async function prunePrefetch(userId: string, keep = PREFETCH_KEEP): Promise<void> {
  const rows = await db.select({ id: ytDownloads.id, assetId: ytDownloads.assetId, updatedAt: ytDownloads.updatedAt })
    .from(ytDownloads)
    .where(and(eq(ytDownloads.userId, userId), eq(ytDownloads.prefetch, true)))
  if (rows.length <= keep) return
  rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  const stale = rows.slice(keep)
  await db.delete(ytDownloads).where(inArray(ytDownloads.id, stale.map(r => r.id)))
  await releaseAssetsIfOrphaned(stale.map(r => r.assetId))
}

// ── Shared YouTube → podcast episode creation (used by /podcast route + auto-podcast) ──

export interface CreateEpisodeOpts {
  showId: string
  userId: string
  firstName: string
  video: { videoId: string; title?: string; author?: string }
  dateLabel: string
  createdAt: Date
  /** Custom episode title (single-video case); falls back to the video's own title. */
  episodeTitle?: string
}

/** Create one pending episode for a single YouTube video: episode row + source link +
 *  podcast-generate job (per-episode content override feeds just this video's transcript). */
export async function createYoutubeEpisode(opts: CreateEpisodeOpts): Promise<void> {
  const episodeId = crypto.randomUUID()
  const epTitle = (opts.episodeTitle?.trim() || opts.video.title?.trim()) || 'YouTube video'

  await db.insert(podcastEpisodes).values({
    id: episodeId,
    showId: opts.showId,
    title: `${epTitle} — ${opts.dateLabel}`,
    status: 'pending',
    createdAt: opts.createdAt,
  })

  // Record the source now (not after generation) so a follow-up batch skips it while this
  // one is still pending. Generation re-inserts with onConflictDoNothing, so this is safe.
  await db.insert(podcastEpisodeSources).values({
    id: crypto.randomUUID(),
    episodeId,
    sourceType: 'youtube',
    sourceId: opts.video.videoId,
    title: opts.video.title ?? null,
    createdAt: opts.createdAt,
  }).onConflictDoNothing()

  const payload = JSON.stringify({
    showId: opts.showId,
    episodeId,
    userId: opts.userId,
    userFirstName: opts.firstName,
    segments: [{ type: 'youtube', label: 'YouTube', params: { videos: [opts.video] } }],
  })

  await db.insert(downloadJobs).values({
    id: crypto.randomUUID(),
    type: 'podcast-generate',
    refId: payload,
    domain: 'podcast',
    sizeClass: 'small',
    label: `Podcast: ${epTitle}`,
    status: 'pending',
    priority: 50,
    attempts: 0,
    maxAttempts: 3,
    variantKey: null,
    lastError: null,
    nextEligibleAt: null,
    progress: null,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  })
}

// ── Rolling keep-N prune ─────────────────────────────────────────────────────────

/** Keep only the newest `keep` auto-saved downloads (of this kind) for a subscription;
 *  delete the rest, files and rows. Manual saves (auto = false) are never touched. */
async function pruneAutoSaves(userId: string, subscriptionId: string, kind: 'audio' | 'video', keep: number): Promise<void> {
  if (keep <= 0) return   // 0/negative → treat as "unlimited", no pruning

  const rows = await db.select({
    id: ytDownloads.id,
    videoId: ytDownloads.videoId,
    assetId: ytDownloads.assetId,
    transcriptRelPath: ytDownloads.transcriptRelPath,
    publishedAt: ytVideos.publishedAt,
    createdAt: ytDownloads.createdAt,
  })
    .from(ytDownloads)
    .innerJoin(ytVideos, eq(ytVideos.videoId, ytDownloads.videoId))
    .where(and(
      eq(ytDownloads.userId, userId),
      eq(ytDownloads.kind, kind),
      eq(ytDownloads.auto, true),
      eq(ytVideos.subscriptionId, subscriptionId),
    ))

  if (rows.length <= keep) return

  // Newest first (by upload date, then save time), keep the first `keep`, prune the tail.
  rows.sort((a, b) =>
    (Number(b.publishedAt ?? 0) - Number(a.publishedAt ?? 0)) ||
    (b.createdAt.getTime() - a.createdAt.getTime()))
  const stale = rows.slice(keep)

  // Transcripts are still per-user files; the media itself is a SHARED blob — never unlink it
  // here (another user may reference the same asset). Delete the refs, then GC reclaims any
  // asset/blob that nobody references anymore.
  for (const r of stale) {
    if (r.transcriptRelPath) { try { await unlink(await resolveUserPath(r.transcriptRelPath)) } catch { /* already gone */ } }
  }
  await db.delete(ytDownloads).where(inArray(ytDownloads.id, stale.map(r => r.id)))
  await releaseAssetsIfOrphaned(stale.map(r => r.assetId))

  // Auto-prune has zero Plex-facing effect otherwise — a rolled-off video would keep
  // showing in the user's Plex library forever even after this function deletes its save.
  if (kind === 'video') {
    const { enqueuePlexSync } = await import('@/lib/downloadJobs')
    for (const r of stale) void enqueuePlexSync(userId, r.videoId, 'remove').catch(() => {})
  }
  logger.info(`[youtube] auto-save pruned ${stale.length} old video(s) for subscription ${subscriptionId} (keep ${keep})`)
}

// ── Orchestrator ─────────────────────────────────────────────────────────────────

export interface FreshVideo {
  videoId: string
  title: string | null
  author: string | null
  publishedAt: number | null
}

/** Run auto-save + auto-podcast for a subscription's newly-discovered uploads. Called by
 *  the feed poller after it upserts fresh videos. No-ops when paused or nothing opted in. */
export async function applySubscriptionAutomation(
  sub: typeof ytSubscriptions.$inferSelect,
  fresh: FreshVideo[],
): Promise<void> {
  if (!fresh.length) return
  if (await isAutomationPaused(sub.userId)) return

  // Newest first so keep-N prunes the right tail and episodes generate newest → oldest.
  const ordered = [...fresh].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))

  // ── Auto-save offline ──
  if (sub.autoSave) {
    try {
      const firstName = await getFirstName(sub.userId)
      const kind: 'audio' | 'video' = sub.autoSaveKind === 'audio' ? 'audio' : 'video'
      const maxHeight = kind === 'audio' ? null : await getEffectiveCap(sub.userId)
      for (const v of ordered) {
        await enqueueVideoSave({ userId: sub.userId, videoId: v.videoId, title: v.title ?? '', kind, maxHeight, firstName, auto: true })
          .catch(err => logger.warn(`[youtube] auto-save enqueue failed for ${v.videoId}: ${err}`))
      }
      const keep = sub.autoSaveKeep ?? await getAutoSaveKeepDefault()
      await pruneAutoSaves(sub.userId, sub.id, kind, keep)
    } catch (err) {
      logger.warn(`[youtube] auto-save failed for "${sub.title}": ${err}`)
    }
  }

  // ── Auto-podcast: feed fresh videos into source-linked shows that opted in ──
  try {
    const shows = await db.select().from(podcastShows).where(and(
      eq(podcastShows.ownerUserId, sub.userId),
      eq(podcastShows.autoGenerate, true),
      eq(podcastShows.sourceRef, `${sub.kind}:${sub.externalId}`),
    ))
    if (shows.length) {
      const firstName = await getFirstName(sub.userId)
      const now = new Date()
      const dateLabel = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      for (const show of shows) {
        // Skip videos already turned into episodes for this show (idempotent re-runs).
        const doneRows = await db.select({ sourceId: podcastEpisodeSources.sourceId })
          .from(podcastEpisodeSources)
          .innerJoin(podcastEpisodes, eq(podcastEpisodeSources.episodeId, podcastEpisodes.id))
          .where(and(eq(podcastEpisodes.showId, show.id), eq(podcastEpisodeSources.sourceType, 'youtube')))
        const done = new Set(doneRows.map(r => r.sourceId))

        let i = 0
        for (const v of ordered) {
          if (done.has(v.videoId)) continue
          await createYoutubeEpisode({
            showId: show.id,
            userId: sub.userId,
            firstName,
            video: { videoId: v.videoId, title: v.title ?? undefined, author: v.author ?? undefined },
            dateLabel,
            createdAt: new Date(now.getTime() - i * 1000),
          })
          i++
        }
        if (i > 0) logger.info(`[youtube] auto-podcast queued ${i} episode(s) for show "${show.name}"`)
      }
    }
  } catch (err) {
    logger.warn(`[youtube] auto-podcast failed for "${sub.title}": ${err}`)
  }
}
