// User-managed hide lists for the YouTube surface (FreeTube's "distraction free"
// blocklists). Filtering happens server-side so every client (web, tvOS, exports)
// benefits without carrying its own copy of the rules.
//
// Preference keys (per user, via the normal preferences API):
//   youtube.hidden_channels  string[] of channel ids or channel names
//   youtube.hidden_keywords  string[] matched case-insensitively against titles

import { eq, and, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences } from '@/db/schema'

const CHANNELS_KEY = 'youtube.hidden_channels'
const KEYWORDS_KEY = 'youtube.hidden_keywords'

export interface YtHiddenFilters {
  channels: string[]
  keywords: string[]
}

function parseList(value: string | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map(v => v.trim())
      .slice(0, 200)
  } catch {
    return []
  }
}

export async function getUserYtHiddenFilters(userId: string): Promise<YtHiddenFilters> {
  const rows = await db.select({ key: userPreferences.key, value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), inArray(userPreferences.key, [CHANNELS_KEY, KEYWORDS_KEY])))
  const map = new Map(rows.map(r => [r.key, r.value]))
  return {
    channels: parseList(map.get(CHANNELS_KEY)),
    keywords: parseList(map.get(KEYWORDS_KEY)),
  }
}

interface Filterable {
  title?: string | null
  author?: string | null
  channelId?: string | null
}

/** True when the item survives the user's hide lists. */
export function passesYtHiddenFilters(filters: YtHiddenFilters, item: Filterable): boolean {
  if (!filters.channels.length && !filters.keywords.length) return true
  if (filters.channels.length) {
    const channelId = item.channelId?.toLowerCase() ?? ''
    const author = item.author?.toLowerCase() ?? ''
    for (const entry of filters.channels) {
      const needle = entry.toLowerCase()
      if (needle && (needle === channelId || needle === author)) return false
    }
  }
  if (filters.keywords.length && item.title) {
    const title = item.title.toLowerCase()
    for (const keyword of filters.keywords) {
      if (keyword && title.includes(keyword.toLowerCase())) return false
    }
  }
  return true
}

/** One-call helper for route handlers: fetch the lists once, filter the batch. */
export async function applyYtHiddenFilters<T extends Filterable>(userId: string, items: T[]): Promise<T[]> {
  if (!items.length) return items
  const filters = await getUserYtHiddenFilters(userId)
  if (!filters.channels.length && !filters.keywords.length) return items
  return items.filter(item => passesYtHiddenFilters(filters, item))
}
