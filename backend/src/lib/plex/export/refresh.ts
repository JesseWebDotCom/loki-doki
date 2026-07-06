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
}
