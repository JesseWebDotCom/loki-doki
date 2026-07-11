// Video duration backfill. YouTube RSS feeds omit duration, which the UI needs to
// split Shorts from regular videos. yt-dlp can print durations without downloading
// media; we persist them onto ytVideos so each video is only ever looked up once.

import { spawn } from 'node:child_process'
import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { ytVideos } from '@/db/schema'
import { ytDlpBin, withYtDlpSlot } from '@/lib/ytdlp'

const MAX_PER_CALL = 50
// Hard cap so a wedged extraction (up to 50 URLs in one process) can't hang a request handler
// forever — backfillDurations is awaited directly in routes/youtube.ts.
const BATCH_TIMEOUT_MS = 90_000

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
    // Route through the global slot so this can't fork-bomb yt-dlp under concurrent requests,
    // and add a wall-clock kill so a wedged extractor releases the slot (--socket-timeout only
    // bounds a single socket read, not an extractor wedge).
    const printed = await withYtDlpSlot(() => new Promise<string>((resolve, reject) => {
      const proc = spawn(ytDlpBin(), ['--no-warnings', '--skip-download', '--socket-timeout', '15', '--print', '%(id)s\t%(duration)s', '--', ...urls], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      let buf = ''
      const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* gone */ } }, BATCH_TIMEOUT_MS)
      proc.stdout?.on('data', (d: Buffer) => { buf += d.toString() })
      proc.on('close', () => { clearTimeout(timer); resolve(buf) })
      proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    }))
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
