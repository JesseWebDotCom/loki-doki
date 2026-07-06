// Targeted Plex library refresh — scans only the given folder instead of the whole
// section, so adding one episode doesn't pay a full-library rescan. Uses the admin
// connection: refreshing a section is a server-owner operation, same as creating one.

import { getPlexConnection } from '@/lib/plex/index'
import { logger } from '@/lib/logger'

const TIMEOUT_MS = 15_000

export async function refreshPlexPath(sectionKey: string, plexPath: string): Promise<void> {
  const conn = await getPlexConnection()
  if (!conn) return
  const params = new URLSearchParams({ path: plexPath, 'X-Plex-Token': conn.token })
  try {
    const res = await fetch(`${conn.baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/refresh?${params.toString()}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) logger.warn(`[plex-export] targeted refresh failed: ${res.status} for ${plexPath}`)
  } catch (err) {
    // Best-effort — Plex's own periodic library scan will eventually pick up the file
    // even if this specific targeted-refresh call fails (network blip, server restart).
    logger.warn(`[plex-export] targeted refresh threw: ${err}`)
  }
  // A `?path=` refresh returns 200 but scans NOTHING for a folder Plex hasn't indexed yet —
  // confirmed live on a freshly provisioned section: 12 placements' targeted refreshes left
  // the library at zero shows, while one full-section refresh found everything. Every new
  // show/season folder hits this, so always back the targeted call with a debounced full
  // scan (trailing, so a burst of placements costs a single rescan).
  schedulePlexSectionRefresh(sectionKey)
}

const pendingFullRefresh = new Map<string, ReturnType<typeof setTimeout>>()

/** Debounced full-section scan (trailing DELAY). Cheap for our library sizes, and the only
 *  reliable way to index newly created folders (see refreshPlexPath). Timers are unref'd —
 *  worst case (backend exits/hot-reloads mid-debounce) Plex's own periodic scan catches up. */
export function schedulePlexSectionRefresh(sectionKey: string, delayMs = 30_000): void {
  const existing = pendingFullRefresh.get(sectionKey)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    pendingFullRefresh.delete(sectionKey)
    void (async () => {
      const conn = await getPlexConnection()
      if (!conn) return
      try {
        const res = await fetch(`${conn.baseUrl}/library/sections/${encodeURIComponent(sectionKey)}/refresh?X-Plex-Token=${encodeURIComponent(conn.token)}`, {
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (!res.ok) logger.warn(`[plex-export] full-section refresh failed: ${res.status}`)
      } catch (err) {
        logger.warn(`[plex-export] full-section refresh threw: ${err}`)
      }
    })()
  }, delayMs)
  timer.unref?.()
  pendingFullRefresh.set(sectionKey, timer)
}
