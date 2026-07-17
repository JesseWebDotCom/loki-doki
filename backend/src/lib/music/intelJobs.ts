// Daily music-intelligence job: refreshes each active listener's Mixes For You, rebuilds
// every Family Blend, and re-runs the offline auto-cache pass. Started from index.ts boot
// (delayed so it never competes with boot work), then every 24h. All best-effort - a
// failure in one user's pass never blocks the others.

import { sqlite } from '@/db'
import { refreshMixesIfStale } from '@/lib/music/mixes'
import { refreshStaleBlends } from '@/lib/music/blends'
import { runAutocacheForAllUsers } from '@/lib/music/autocache'
import { logger } from '@/lib/logger'

const DAY_MS = 24 * 60 * 60 * 1000

/** Users with any listening in the last 30 days - the only ones worth computing for. */
function activeListeners(): string[] {
  const since = Math.floor(Date.now() / 1000) - 30 * 86_400
  const rows = sqlite.prepare(`
    SELECT DISTINCT user_id FROM music_history WHERE played_at >= ?
  `).all(since) as Array<{ user_id: string }>
  return rows.map(r => r.user_id)
}

let running = false

export async function runMusicIntelPass(): Promise<void> {
  if (running) return
  running = true
  try {
    for (const userId of activeListeners()) {
      try { await refreshMixesIfStale(userId) } catch (err) {
        logger.debug(`[music-intel] mixes refresh failed for ${userId}: ${String(err)}`)
      }
    }
    await refreshStaleBlends().catch((err) => {
      logger.debug(`[music-intel] blend refresh failed: ${String(err)}`)
    })
    await runAutocacheForAllUsers().catch((err) => {
      logger.debug(`[music-intel] autocache pass failed: ${String(err)}`)
    })
  } finally {
    running = false
  }
}

export function startMusicIntelJobs(): void {
  setTimeout(() => { void runMusicIntelPass() }, 3 * 60 * 1000)
  setInterval(() => { void runMusicIntelPass() }, DAY_MS).unref()
}
