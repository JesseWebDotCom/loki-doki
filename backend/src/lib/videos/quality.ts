// Save-quality governance for hub sources (TikTok/Vimeo/Reddit) — the per-source twin of
// lib/youtube/quality.ts, same three stacking tiers:
//   1. global per-source cap — appSettings `videos.save_max_height.<source>` (admin)
//   2. per-user cap          — appSettings `videos.save_max_height.<source>.<userId>` (admin)
//   3. user preference       — userPreferences `videos.save_quality.<source>`
// Effective height = min(preference ?? cap, cap). Caps live in appSettings (not user-
// writable) for the same reason as YouTube's: /preferences would let users lift their own
// ceiling.
//
// Known limitation (documented, not solved here): hub assets are coalesced per
// (source, videoId, kind, 'mp4') with NO height variants — the first requester's height
// wins for the whole household (no store-the-max like YouTube's asset layer).

import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { getAppSetting } from '@/lib/settings'
import { SAVE_HEIGHTS, DEFAULT_GLOBAL_CAP, type SaveHeight } from '@/lib/youtube/quality'

export { SAVE_HEIGHTS, type SaveHeight }

export const sourceCapKey = (source: string) => `videos.save_max_height.${source}`
export const sourceUserCapKey = (source: string, userId: string) => `videos.save_max_height.${source}.${userId}`
export const sourcePrefKey = (source: string) => `videos.save_quality.${source}`

function asHeight(v: unknown): SaveHeight | null {
  const n = typeof v === 'number' ? v : Number(v)
  return (SAVE_HEIGHTS as readonly number[]).includes(n) ? (n as SaveHeight) : null
}

/** Admin global cap for one source (falls back to the shared 1080 default). */
export async function getSourceCap(source: string): Promise<SaveHeight> {
  return asHeight(await getAppSetting(sourceCapKey(source))) ?? DEFAULT_GLOBAL_CAP
}

/** The cap that actually applies to a user for one source. */
export async function getEffectiveSourceCap(userId: string, source: string): Promise<SaveHeight> {
  return asHeight(await getAppSetting(sourceUserCapKey(source, userId))) ?? (await getSourceCap(source))
}

/** The user's own preferred save height for one source, or null (→ cap applies). */
export async function getSourcePreference(userId: string, source: string): Promise<SaveHeight | null> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, sourcePrefKey(source))))
    .limit(1)
  if (!row) return null
  try { return asHeight(JSON.parse(row.value)) } catch { return null }
}

/** The height a save/auto-save for this (user, source) is actually fetched at. */
export async function effectiveSaveHeight(userId: string, source: string): Promise<SaveHeight> {
  const cap = await getEffectiveSourceCap(userId, source)
  const pref = await getSourcePreference(userId, source)
  return pref != null && pref < cap ? pref : cap
}
