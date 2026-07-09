// Karaoke stem cache TTL sweep. A prepared karaoke track (source.wav + vocals/no_vocals stems +
// aligned lyrics) is kept so re-singing the same song is instant — no second Demucs run. To keep
// disk from growing forever, drop karaoke tracks that haven't been used in a while (last_used_at
// is bumped every time the song is prepared/re-sung). Studio tracks (origin 'studio') are never
// touched — those are the user's saved projects.

import { eq } from 'drizzle-orm'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { db } from '@/db'
import { musicStudioTracks } from '@/db/schema'
import { resolveUserPath } from '@/lib/storage/paths'
import { logger } from '@/lib/logger'

const TTL_MS = 30 * 24 * 3600_000   // delete karaoke tracks unused for 30 days

export async function sweepKaraokeCache(): Promise<number> {
  const cutoff = Date.now() - TTL_MS
  const rows = await db.select().from(musicStudioTracks).where(eq(musicStudioTracks.origin, 'karaoke'))
  const stale = rows.filter((t) => ((t.lastUsedAt ?? t.createdAt)?.getTime() ?? 0) < cutoff)
  let removed = 0
  for (const t of stale) {
    try {
      // The whole per-track dir holds source.wav + stems/ + cover — remove it wholesale.
      if (t.sourceRelPath) await rm(dirname(await resolveUserPath(t.sourceRelPath)), { recursive: true, force: true }).catch(() => {})
      await db.delete(musicStudioTracks).where(eq(musicStudioTracks.id, t.id))
      removed++
    } catch (err) { logger.debug(`[karaoke-cache] sweep ${t.id} failed: ${String(err)}`) }
  }
  if (removed) logger.info(`[karaoke-cache] swept ${removed} karaoke track(s) unused for 30d`)
  return removed
}

/** Run the sweep on boot and once a day. */
export function startKaraokeCacheSweep(): void {
  void sweepKaraokeCache().catch(() => {})
  const iv = setInterval(() => void sweepKaraokeCache().catch(() => {}), 24 * 3600_000)
  iv.unref?.()
}
