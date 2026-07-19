// Continue-watching transcript warm: while the system is idle, make sure every video a
// household member is partway through has a transcript ready for when they come back.
// Platform captions are grabbed and cached first (cheap yt-dlp caption fetch, same as the
// watch page's Transcript tab); only caption-less videos get a Whisper job, enqueued at
// OPPORTUNISTIC_PRIORITY so the idle gate holds the actual compute until nobody needs the
// machine. Feeds Ask-the-video, semantic search, and the Transcript tab.
//
// Sources: yt_watch_state (YouTube, origin 'youtube' only - music-station plays are not
// "continue watching") and video_watch_state (TikTok/Vimeo/Reddit) - the same rows the
// hub's Continue Watching shelves render. Plex/media items are deliberately out of scope:
// their bytes aren't reachable through the yt-dlp audio fetch this pipeline uses.

import { and, desc, eq, gt } from 'drizzle-orm'
import { db } from '@/db'
import { users, videoItems, videoTranscripts, videoWatchState, ytVideos, ytWatchState } from '@/db/schema'
import { enqueueVideoTranscription } from '@/lib/videos/transcribe'
import { OPPORTUNISTIC_PRIORITY, shouldRunOpportunistic } from '@/lib/idleScheduler'
import { logger } from '@/lib/logger'

const MAX_CANDIDATES = 12       // most-recent continue-watching videos considered per pass
const MAX_WHISPER_PER_PASS = 2  // new Whisper enqueues per pass (mirrors the auto-transcribe caps)
const MIN_POSITION_SEC = 5      // same "actually started watching" floor the shelves use

interface Candidate {
  source: string
  videoId: string
  url: string
  durationSec: number | null
  userId: string
  updatedAt: Date
}

async function collectCandidates(): Promise<Candidate[]> {
  // Non-YouTube hub sources: watch state joined to the item snapshot for the page URL.
  // A row with no video_items match has no URL to fetch from (the history shelf drops
  // those too), so the inner join is the right filter, not a data loss.
  const generic = await db.select({
    source: videoWatchState.source, videoId: videoWatchState.videoId,
    userId: videoWatchState.userId, updatedAt: videoWatchState.updatedAt,
    url: videoItems.url, durationSec: videoItems.durationSec, isAdult: videoItems.isAdult,
  })
    .from(videoWatchState)
    .innerJoin(videoItems, and(eq(videoItems.source, videoWatchState.source), eq(videoItems.externalId, videoWatchState.videoId)))
    .where(and(eq(videoWatchState.completed, false), gt(videoWatchState.positionSec, MIN_POSITION_SEC)))
    .orderBy(desc(videoWatchState.updatedAt))
    .limit(MAX_CANDIDATES)

  const youtube = await db.select({
    videoId: ytWatchState.videoId, userId: ytWatchState.userId, updatedAt: ytWatchState.updatedAt,
    durationSec: ytVideos.durationSec,
  })
    .from(ytWatchState)
    .leftJoin(ytVideos, eq(ytVideos.videoId, ytWatchState.videoId))
    .where(and(
      eq(ytWatchState.completed, false),
      eq(ytWatchState.origin, 'youtube'),
      gt(ytWatchState.positionSec, MIN_POSITION_SEC),
    ))
    .orderBy(desc(ytWatchState.updatedAt))
    .limit(MAX_CANDIDATES)

  const merged: Candidate[] = [
    ...generic.filter((r) => !r.isAdult).map((r) => ({
      source: r.source as string, videoId: r.videoId, url: r.url,
      durationSec: r.durationSec, userId: r.userId, updatedAt: r.updatedAt,
    })),
    ...youtube.map((r) => ({
      source: 'youtube', videoId: r.videoId,
      url: `https://www.youtube.com/watch?v=${r.videoId}`,
      durationSec: r.durationSec ?? null, userId: r.userId, updatedAt: r.updatedAt,
    })),
  ]

  // Two household members mid-way through the same video share one transcript: keep the
  // most recent watcher's row per (source, videoId), newest first, bounded per pass.
  merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const c of merged) {
    const key = `${c.source}:${c.videoId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
    if (out.length >= MAX_CANDIDATES) break
  }
  return out
}

const firstNameCache = new Map<string, string>()
async function firstNameFor(userId: string): Promise<string> {
  const cached = firstNameCache.get(userId)
  if (cached) return cached
  const [u] = await db.select({ firstName: users.firstName }).from(users).where(eq(users.id, userId)).limit(1)
  const name = u?.firstName ?? 'user'
  firstNameCache.set(userId, name)
  return name
}

/** One pass over the household's continue-watching videos. Call on the videos poller
 *  cadence; skips itself entirely while the system is busy (the caption fetches run
 *  in-pass, so the whole pass - not just the Whisper jobs - respects the idle gate). */
export async function runContinueWatchTranscriptPass(): Promise<void> {
  if (!shouldRunOpportunistic()) return

  const candidates = await collectCandidates()
  if (!candidates.length) return

  let whisperBudget = MAX_WHISPER_PER_PASS
  for (const c of candidates) {
    // Only videos never attempted: ready means done, pending/processing means in flight,
    // and a failed row stays failed (no auto-retry loop; the watch page's Transcribe
    // button still resets it on demand).
    const [existing] = await db.select({ status: videoTranscripts.status }).from(videoTranscripts)
      .where(and(eq(videoTranscripts.source, c.source), eq(videoTranscripts.videoId, c.videoId))).limit(1)
    if (existing) continue

    // Captions first, exactly like the watch page and the auto-transcribe pollers: a video
    // whose platform captions resolve gets them cached now and never needs Whisper.
    try {
      const firstName = await firstNameFor(c.userId)
      const captions = c.source === 'youtube'
        ? await (await import('@/lib/youtube/download')).ensureTranscript(c.videoId, c.userId, firstName).catch(() => null)
        : await (await import('@/lib/podcast/transcript')).resolveVideoVtt(
          { videoId: c.videoId, source: c.source, url: c.url }, c.userId, firstName,
        ).catch(() => null)
      if (captions) continue
    } catch (err) {
      logger.warn(`[continue-watch] caption grab failed for ${c.source}:${c.videoId}: ${err}`)
      continue
    }

    if (whisperBudget <= 0) continue
    whisperBudget--
    await enqueueVideoTranscription(c.source, c.videoId, c.url, c.durationSec, null, { priority: OPPORTUNISTIC_PRIORITY })
      .then(() => logger.info(`[continue-watch] queued idle transcription for ${c.source}:${c.videoId}`))
      .catch((err) => logger.warn(`[continue-watch] transcribe enqueue failed for ${c.source}:${c.videoId}: ${err}`))
  }
}
