// Video duration backfill. YouTube RSS feeds omit duration, which the UI needs to
// split Shorts from regular videos. yt-dlp can print durations without downloading
// media; we persist them onto ytVideos so each video is only ever looked up once.

import { spawn } from 'node:child_process'
import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { ytVideos } from '@/db/schema'
import { ytDlpBin } from '@/lib/youtube/ytdlp'

const MAX_PER_CALL = 50

/**
 * Resolve durations for the given videoIds, fetching only those we don't already
 * know. Persists newly-fetched durations onto ytVideos. Returns a videoId→seconds
 * map for everything we now know. Best-effort: yt-dlp failures yield a partial map.
 */
export async function backfillDurations(videoIds: string[]): Promise<Record<string, number>> {
  const ids = Array.from(new Set((videoIds ?? []).filter(Boolean))).slice(0, MAX_PER_CALL)
  if (!ids.length) return {}

  const known = await db.select({ videoId: ytVideos.videoId, durationSec: ytVideos.durationSec })
    .from(ytVideos).where(inArray(ytVideos.videoId, ids))
  const haveMap = new Map(known.map(k => [k.videoId, k.durationSec]))

  const out: Record<string, number> = {}
  for (const [id, dur] of haveMap) if (dur) out[id] = dur

  const missing = ids.filter(id => !haveMap.get(id))
  if (!missing.length) return out

  try {
    const urls = missing.map(id => `https://www.youtube.com/watch?v=${id}`)
    const printed = await new Promise<string>((resolve, reject) => {
      const proc = spawn(ytDlpBin(), ['--no-warnings', '--skip-download', '--print', '%(id)s\t%(duration)s', ...urls], { stdio: ['ignore', 'pipe', 'ignore'] })
      let buf = ''
      proc.stdout?.on('data', (d: Buffer) => { buf += d.toString() })
      proc.on('close', () => resolve(buf))
      proc.on('error', reject)
    })
    for (const line of printed.split('\n')) {
      const [id, durStr] = line.split('\t')
      const dur = parseInt(durStr ?? '', 10)
      if (id && Number.isFinite(dur) && dur > 0) {
        out[id] = dur
        await db.update(ytVideos).set({ durationSec: dur }).where(eq(ytVideos.videoId, id)).catch(() => {})
      }
    }
  } catch { /* best-effort */ }

  return out
}
