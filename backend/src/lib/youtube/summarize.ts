// Shared video enrichment: transcript-based summaries and yt-dlp metadata, used by
// both the on-demand summarize route and the Save flow (which enriches in the
// background so Description + Summary are available offline without a manual click).

import { spawn } from 'node:child_process'
import { eq, and, isNull, isNotNull } from 'drizzle-orm'
import { db } from '@/db'
import { ytVideos, ytCollections, ytWatchState } from '@/db/schema'
import { getTranscriptText } from '@/lib/youtube/transcript'
import { ytDlpBin } from '@/lib/ytdlp'
import { innertubeChannelAvatar } from '@/lib/youtube/innertube'
import { getOrFetchImage } from '@/lib/youtube/imageCache'
import { cachedLookup } from '@/lib/lookupCache'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import { logger } from '@/lib/logger'

const SUMMARY_SYSTEM =
  'You write a 3-5 paragraph summary of a video, based on its transcript. ' +
  'Dive straight into the content itself. Do NOT begin with meta openers like "The video transcript describes", ' +
  '"This video", "In this video", "The speaker", "The transcript" — write as if explaining the subject directly. ' +
  'The transcript may be auto-generated and may be cut off; summarize whatever is present, never ask the user for ' +
  'more, never mention that it is incomplete, and never address the reader. ' +
  'The transcript may be in any language — always write the summary in English regardless of the transcript\'s ' +
  'language. Output only the summary.'

// Safety net: even with the instruction above, small models sometimes lead with a meta
// preamble. Strip a single such opening clause so the summary starts on substance.
const META_OPENER = /^\s*(?:the\s+(?:video|transcript|clip|speaker|presenter|narrator|content)|this\s+(?:video|transcript|clip)|in\s+this\s+video|the\s+video\s+transcript)\b[^.!?\n]*?\b(?:describes?|discusses?|explains?|covers?|presents?|is\s+about|talks?\s+about|shows?|details?|outlines?|summari[sz]es?)\b[:,]?\s*/i

function stripMetaOpener(text: string): string {
  const cleaned = text.replace(META_OPENER, '')
  if (cleaned === text || !cleaned) return text
  // Re-capitalize the first letter after trimming the preamble.
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

// Coalesce concurrent requests for the same video (eager player open + on-play hook +
// Save hook can all fire at once) into a single generation.
const _inFlight = new Map<string, Promise<string | null>>()

/**
 * Return the cached summary for a video, generating + caching one from its captions
 * if absent. Returns null only when the video has no captions to summarize.
 */
export function ensureSummary(videoId: string, userId: string, firstName: string): Promise<string | null> {
  const existing = _inFlight.get(videoId)
  if (existing) return existing
  const p = generateSummary(videoId, userId, firstName)
  _inFlight.set(videoId, p)
  return p.finally(() => _inFlight.delete(videoId))
}

async function generateSummary(videoId: string, userId: string, firstName: string): Promise<string | null> {
  const [video] = await db.select().from(ytVideos).where(eq(ytVideos.videoId, videoId)).limit(1)
  if (video?.summary) return video.summary

  const text = (await getTranscriptText(videoId, userId, firstName))?.slice(0, 12_000)
  if (!text) { logger.info({ videoId }, 'yt summary: skipped (no captions)'); return null }

  logger.info({ videoId }, 'yt summary: generating')
  const model = await getFastModel()
  const result = await ollamaChat(model, [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: text },
  ], undefined, { temperature: 0.3, num_predict: 600 })
  const summary = stripMetaOpener(result.message.content.trim())
  if (!summary) return null

  // Upsert so search-result videos (no pre-existing row) still cache their summary.
  await db.insert(ytVideos)
    .values({ id: crypto.randomUUID(), videoId, title: video?.title ?? '', summary, createdAt: new Date() })
    .onConflictDoUpdate({ target: ytVideos.videoId, set: { summary } })
  logger.info({ videoId, chars: summary.length }, 'yt summary: cached')
  return summary
}

interface YtDlpMeta { title?: string; channel?: string; uploader?: string; channel_id?: string; description?: string; duration?: number }

/**
 * Ensure a yt_videos row exists with a description for a saved video, fetching it via
 * yt-dlp when missing. Lets the offline Description tab show real text for videos that
 * were saved directly from search (and so were never in a subscription feed).
 */
export async function ensureSavedVideoMeta(videoId: string, fallbackTitle = ''): Promise<void> {
  const [v] = await db.select().from(ytVideos).where(eq(ytVideos.videoId, videoId)).limit(1)

  // Fetch yt-dlp metadata only when the description (what the offline tabs need) is missing.
  let channelId = v?.channelId ?? null
  if (!v?.description) {
    const json = await new Promise<string>((resolve, reject) => {
      const proc = spawn(ytDlpBin(), ['-J', '--no-playlist', `https://www.youtube.com/watch?v=${videoId}`], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
      proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(`yt-dlp exited ${code}`)))
      proc.on('error', reject)
    }).catch(() => null)

    if (json) {
      let m: YtDlpMeta | null = null
      try { m = JSON.parse(json) as YtDlpMeta } catch { /* malformed — keep what we have */ }
      if (m) {
        channelId = m.channel_id ?? channelId
        await db.insert(ytVideos)
          .values({
            id: crypto.randomUUID(),
            videoId,
            title: m.title ?? v?.title ?? fallbackTitle,
            author: m.channel ?? m.uploader ?? '',
            channelId: m.channel_id ?? null,
            description: m.description ?? null,
            durationSec: m.duration ?? null,
            createdAt: new Date(),
          })
          .onConflictDoUpdate({
            target: ytVideos.videoId,
            set: { description: m.description ?? null, channelId: m.channel_id ?? null, durationSec: m.duration ?? null },
          })
      }
    }
  }

  await ensureChannelThumb(videoId, channelId)
}

/**
 * Resolve + persist + warm a video's channel avatar so library cards (Saved offline, Watch
 * Later, Liked, History) show the real logo — online AND offline — even for non-subscribed
 * channels. Cheap: uses the known channelId (no yt-dlp subprocess), caches the resolved URL
 * for 7 days, and warms the image bytes into the disk cache. reconcileSubscribed (imageCache.ts)
 * then pins any yt_videos.channel_thumb against the 24h eviction so it survives offline.
 */
export async function ensureChannelThumb(videoId: string, channelId: string | null | undefined): Promise<void> {
  if (!channelId) return
  const [v] = await db.select({ channelThumb: ytVideos.channelThumb }).from(ytVideos).where(eq(ytVideos.videoId, videoId)).limit(1)
  if (v?.channelThumb) return
  const avatar = await cachedLookup('yt-channel-avatar', channelId, 7 * 24 * 60 * 60 * 1000, () => innertubeChannelAvatar(channelId)).catch(() => null)
  if (!avatar) return
  await db.insert(ytVideos)
    .values({ id: crypto.randomUUID(), videoId, channelId, channelThumb: avatar, createdAt: new Date() })
    .onConflictDoUpdate({ target: ytVideos.videoId, set: { channelThumb: avatar, channelId } })
    .catch(() => {})
  await getOrFetchImage(avatar).catch(() => null)   // warm disk cache for offline
}

// One-shot, per-video guarded backfills that fill missing channel avatars for the library
// tabs. Each runs in the background off a list-endpoint poll; once a video's channel_thumb is
// set it's skipped, so steady-state cost is zero.
const _thumbJobs = new Set<string>()
async function runThumbBackfill(rows: { videoId: string; channelId: string | null }[]): Promise<void> {
  for (const r of rows) {
    if (_thumbJobs.has(r.videoId)) continue
    _thumbJobs.add(r.videoId)
    try { await ensureChannelThumb(r.videoId, r.channelId) }
    catch { /* best-effort */ } finally { _thumbJobs.delete(r.videoId) }
  }
}

/** Watch Later / Liked: resolve avatars using the channelId stored on the collection row. */
export async function backfillCollectionChannelThumbs(userId: string): Promise<void> {
  const rows = await db.select({ videoId: ytCollections.videoId, channelId: ytCollections.channelId })
    .from(ytCollections)
    .leftJoin(ytVideos, eq(ytVideos.videoId, ytCollections.videoId))
    .where(and(eq(ytCollections.userId, userId), isNotNull(ytCollections.channelId), isNull(ytVideos.channelThumb)))
  await runThumbBackfill(rows)
}

/** History: resolve avatars using the channelId already on the watched video's yt_videos row. */
export async function backfillHistoryChannelThumbs(userId: string): Promise<void> {
  const rows = await db.select({ videoId: ytWatchState.videoId, channelId: ytVideos.channelId })
    .from(ytWatchState)
    .innerJoin(ytVideos, eq(ytVideos.videoId, ytWatchState.videoId))
    .where(and(eq(ytWatchState.userId, userId), isNotNull(ytVideos.channelId), isNull(ytVideos.channelThumb)))
  await runThumbBackfill(rows)
}
