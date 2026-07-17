// Kids allowlist-only mode: the strictest video protection, the inverse of the ceiling.
// The ceiling asks "is this too mature?"; allowlist-only asks "did a parent approve this
// creator (or this exact video)?" and hides everything else. Enforced inside the same two
// chokepoints as the ceiling (filterVideosForUser + videoAllowedForUser), so every list
// route, search, suggestion rail, up-next and direct link is covered without per-route
// work. Entries are per-child, admin-managed (Admin > Accounts).
//
// Fail direction: if the mode FLAG can't be read we treat the mode as off (matching the
// house "never hide an adult's feed on a policy error" rule), but once the mode is known
// to be ON, an entries read error yields an EMPTY allowlist, which blocks everything.
// For a kid gate, failing closed is the only acceptable failure.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { videoAllowlist } from '@/db/schema'
import { getUserPref } from '@/lib/contentPolicy'
import { logger } from '@/lib/logger'
import type { VideoItem } from '@/lib/videos/types'

export const ALLOWLIST_PREF = 'videos.allowlistOnly'

export interface AllowlistView {
  /** `${source}:${externalId.toLowerCase()}` for approved creators/channels. */
  creators: Set<string>
  /** `${source}:${videoId}` for individually approved videos. */
  videos: Set<string>
}

// Short-lived per-user cache: the view is consulted on every list request, sometimes
// several times per page, and admin edits are rare. 15s keeps edits feeling immediate.
const cache = new Map<string, { at: number; view: AllowlistView | null }>()
const CACHE_MS = 15_000

export function invalidateAllowlistCache(userId?: string): void {
  if (userId) cache.delete(userId)
  else cache.clear()
}

export async function allowlistOnlyEnabled(userId: string): Promise<boolean> {
  try {
    return (await getUserPref(userId, ALLOWLIST_PREF)) === true
  } catch (err) {
    logger.debug(`[videos/allowlist] flag read failed (treated off): ${String(err)}`)
    return false
  }
}

/** The user's allowlist, or null when allowlist-only mode is off for them. */
export async function allowlistViewFor(userId: string): Promise<AllowlistView | null> {
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.view
  let view: AllowlistView | null = null
  if (await allowlistOnlyEnabled(userId)) {
    view = { creators: new Set(), videos: new Set() }
    try {
      const rows = await db.select({
        source: videoAllowlist.source, kind: videoAllowlist.kind, externalId: videoAllowlist.externalId,
      }).from(videoAllowlist).where(eq(videoAllowlist.userId, userId))
      for (const r of rows) {
        if (r.kind === 'creator') view.creators.add(`${r.source}:${r.externalId.toLowerCase()}`)
        else view.videos.add(`${r.source}:${r.externalId}`)
      }
    } catch (err) {
      // Mode is on but entries are unreadable: keep the empty view (blocks everything).
      logger.warn(`[videos/allowlist] entries read failed (blocking all): ${String(err)}`)
    }
  }
  cache.set(userId, { at: Date.now(), view })
  return view
}

/** True when the item is from an approved creator or is itself approved. */
export function allowlistPermits(view: AllowlistView, item: Pick<VideoItem, 'source' | 'id' | 'creator'>): boolean {
  if (view.videos.has(`${item.source}:${item.id}`)) return true
  const creatorId = item.creator?.id?.toLowerCase()
  return !!creatorId && view.creators.has(`${item.source}:${creatorId}`)
}
