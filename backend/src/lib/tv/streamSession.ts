// Path B stream engine v1 (plans/doki-tv.md): a continuous MPEG-TS stream per viewer,
// built by chaining one ffmpeg process per schedule block into the same HTTP response.
// Every block is re-encoded to one consistent profile (720p30 h264 + 48k stereo aac) so
// back-to-back TS segments concatenate cleanly. Page/audio-only blocks stream a slate
// (SMPTE bars via lavfi, no font/asset dependencies). Sessions are capped and torn down
// when the client disconnects.

import { spawn, type ChildProcess } from 'node:child_process'
import { and, eq, gt, lte, asc } from 'drizzle-orm'
import { db } from '@/db'
import { tvSchedule, tvChannels, podcastEpisodes, musicRadioStations } from '@/db/schema'
import { ensureFfmpeg, ffmpegBin } from '@/lib/ffmpeg'
import { getPlexConnection, getPlayback, partUrl } from '@/lib/plex'
import { resolveStreamUrl } from '@/lib/youtube/stream'
import { getFrigateConfig } from '@/lib/frigate/config'
import { logger } from '@/lib/logger'
import type { TvBlockPayload } from './types'

const MAX_SESSIONS = 3
let activeSessions = 0

export function tvStreamCapacityLeft(): boolean {
  return activeSessions < MAX_SESSIONS
}

interface BlockInput {
  /** ffmpeg args placed before the output options (inputs + seeks). */
  args: string[]
  /** Cap the run to this many seconds (block remainder). */
  maxSec: number
}

const SLATE_VIDEO = 'smptehdbars=size=1280x720:rate=30'
const SILENCE = 'anullsrc=r=48000:cl=stereo'

function slateInput(maxSec: number): BlockInput {
  return { args: ['-re', '-f', 'lavfi', '-i', SLATE_VIDEO, '-f', 'lavfi', '-i', SILENCE], maxSec }
}

/** Resolve one schedule block into concrete ffmpeg input args. Falls back to a slate. */
async function resolveBlockInput(payload: TvBlockPayload, offsetSec: number, remainSec: number): Promise<BlockInput> {
  const maxSec = Math.max(5, Math.ceil(remainSec))
  try {
    if (payload.src === 'plex') {
      const conn = await getPlexConnection()
      if (!conn) return slateInput(maxSec)
      const playback = await getPlayback(conn, payload.ratingKey)
      if (!playback?.partKey) return slateInput(maxSec)
      return { args: ['-re', '-ss', String(Math.floor(offsetSec)), '-i', partUrl(conn, playback.partKey)], maxSec }
    }
    if (payload.src === 'youtube') {
      const url = await resolveStreamUrl(payload.videoId, 'video', 'auto')
      if (!url) return slateInput(maxSec)
      return { args: ['-re', '-ss', String(Math.floor(offsetSec)), '-i', url], maxSec }
    }
    if (payload.src === 'live') {
      const feed = payload.feed
      if (feed.type === 'frigate' && feed.camera) {
        const cfg = await getFrigateConfig()
        if (!cfg.enabled || !cfg.baseUrl) return slateInput(maxSec)
        return { args: ['-f', 'mjpeg', '-i', `${cfg.baseUrl}/api/${encodeURIComponent(feed.camera)}?fps=10`, '-f', 'lavfi', '-i', SILENCE], maxSec }
      }
      if (feed.url && (feed.type === 'hls' || feed.type === 'video-loop')) {
        return { args: feed.type === 'video-loop' ? ['-re', '-stream_loop', '-1', '-i', feed.url] : ['-i', feed.url], maxSec }
      }
      if (feed.url && feed.type === 'mjpeg') {
        return { args: ['-f', 'mjpeg', '-i', feed.url, '-f', 'lavfi', '-i', SILENCE], maxSec }
      }
      return slateInput(maxSec)
    }
    if (payload.src === 'podcast') {
      const rows = await db.select({ enclosureUrl: podcastEpisodes.enclosureUrl }).from(podcastEpisodes).where(eq(podcastEpisodes.id, payload.episodeId)).limit(1)
      const url = rows[0]?.enclosureUrl
      if (!url) return slateInput(maxSec)
      return { args: ['-re', '-f', 'lavfi', '-i', SLATE_VIDEO, '-ss', String(Math.floor(offsetSec)), '-i', url], maxSec }
    }
    if (payload.src === 'live-radio') {
      const rows = await db.select({ streamUrl: musicRadioStations.streamUrl }).from(musicRadioStations).limit(1)
      const url = rows[0]?.streamUrl
      if (!url) return slateInput(maxSec)
      return { args: ['-re', '-f', 'lavfi', '-i', SLATE_VIDEO, '-i', url], maxSec }
    }
  } catch (err) {
    logger.warn('[tv] block input resolve failed', { src: payload.src, err: err instanceof Error ? err.message : String(err) })
  }
  // page / station / segment / filler / offair (and any failure above): branded bars.
  return slateInput(maxSec)
}

const OUTPUT_ARGS = [
  '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30',
  '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '60',
  '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
  '-map', '0:v:0?', '-map', '1:a:0?', '-map', '0:a:0?',
  '-f', 'mpegts', 'pipe:1',
]

async function currentBlock(channelId: string): Promise<{ payload: TvBlockPayload; endAt: Date; startAt: Date } | null> {
  const now = new Date()
  const rows = await db.select().from(tvSchedule)
    .where(and(eq(tvSchedule.channelId, channelId), lte(tvSchedule.startAt, now), gt(tvSchedule.endAt, now)))
    .orderBy(asc(tvSchedule.startAt))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return { payload: JSON.parse(row.payload) as TvBlockPayload, endAt: row.endAt, startAt: row.startAt }
}

/**
 * Open a continuous MPEG-TS stream for a channel. The returned stream ends only when the
 * consumer cancels (client disconnect) or the channel has no schedule at all.
 */
export async function openChannelTsStream(channelSlug: string): Promise<ReadableStream<Uint8Array> | null> {
  const chRows = await db.select().from(tvChannels).where(eq(tvChannels.slug, channelSlug)).limit(1)
  const channel = chRows[0]
  if (!channel || !channel.enabled) return null
  await ensureFfmpeg()

  let proc: ChildProcess | null = null
  let stopped = false
  activeSessions++

  const cleanup = () => {
    if (stopped) return
    stopped = true
    activeSessions--
    try { proc?.kill('SIGKILL') } catch { /* already gone */ }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          while (!stopped) {
            const block = await currentBlock(channel.id)
            const now = Date.now()
            let input: BlockInput
            if (!block) {
              // No schedule (fresh boot, disabled sources): 30s of bars, then re-check.
              input = slateInput(30)
            } else {
              const offsetSec = (now - block.startAt.getTime()) / 1000
              const remainSec = (block.endAt.getTime() - now) / 1000
              input = await resolveBlockInput(block.payload, offsetSec, remainSec)
            }
            if (stopped) break

            const args = ['-hide_banner', '-loglevel', 'error', ...input.args, '-t', String(input.maxSec), ...OUTPUT_ARGS]
            const child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'ignore'] })
            proc = child

            // Hard backstop: a live input does not honor -t reliably once stalled.
            const killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, (input.maxSec + 10) * 1000)

            child.stdout?.on('data', (chunk: Buffer) => {
              if (stopped) return
              try {
                controller.enqueue(new Uint8Array(chunk))
              } catch {
                // Consumer gone; stop the whole session.
                cleanup()
              }
            })

            await new Promise<void>((resolve) => {
              child.once('exit', () => resolve())
              child.once('error', () => resolve())
            })
            clearTimeout(killTimer)
            proc = null

            // If ffmpeg died immediately (bad input), do not spin: idle out the rest of
            // the block on bars so the client keeps a picture.
            if (!stopped && block && Date.now() < block.endAt.getTime() - 5000 && Date.now() - now < 3000) {
              const remain = Math.min((block.endAt.getTime() - Date.now()) / 1000, 60)
              const slate = slateInput(remain)
              const slateArgs = ['-hide_banner', '-loglevel', 'error', ...slate.args, '-t', String(slate.maxSec), ...OUTPUT_ARGS]
              const slateChild = spawn(ffmpegBin(), slateArgs, { stdio: ['ignore', 'pipe', 'ignore'] })
              proc = slateChild
              slateChild.stdout?.on('data', (chunk: Buffer) => {
                if (stopped) return
                try { controller.enqueue(new Uint8Array(chunk)) } catch { cleanup() }
              })
              await new Promise<void>((resolve) => {
                slateChild.once('exit', () => resolve())
                slateChild.once('error', () => resolve())
              })
              proc = null
            }
          }
        } catch (err) {
          logger.warn('[tv] stream session error', { channel: channelSlug, err: err instanceof Error ? err.message : String(err) })
        } finally {
          cleanup()
          try { controller.close() } catch { /* already closed */ }
        }
      })()
    },
    cancel() {
      cleanup()
    },
  })
}
