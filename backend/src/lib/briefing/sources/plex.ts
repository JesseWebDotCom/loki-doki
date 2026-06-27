// Ambient "what's new on your Plex" for the daily briefing. Global (not location-specific),
// gated on Plex being configured — degrades to empty otherwise, like every other source.

import { getPlexConnection, recentlyAdded } from '@/lib/plex'
import type { BriefingItem } from '../types'

export async function plexRecentlyAdded(limit = 4): Promise<BriefingItem[]> {
  const conn = await getPlexConnection()
  if (!conn) return []
  const items = await recentlyAdded(conn, limit)
  return items.map((i) => ({ title: `${i.title}${i.year ? ` (${i.year})` : ''}` }))
}
