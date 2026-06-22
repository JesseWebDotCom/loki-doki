// Save-quality governance for the YouTube app.
//
// Three tiers stack to produce the height a "Save offline" download is fetched at:
//   1. global cap      — appSettings `youtube.save_max_height` (admin, all users)
//   2. per-user cap     — appSettings `youtube.save_max_height.<userId>` (admin, one user)
//   3. user preference  — userPreferences `youtube.save_quality` (the user's own choice)
//
// The admin caps live in appSettings (global, NOT user-writable) on purpose: the user's
// own `/preferences` endpoint can write any key, so storing the cap there would let a user
// lift their own ceiling. The effective height is min(preference, effective cap).

import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { getAppSetting } from '@/lib/settings'

/** Max video heights offered for Save. `audio` is modelled separately via kind='audio'. */
export const SAVE_HEIGHTS = [360, 480, 720, 1080, 1440, 2160] as const
export type SaveHeight = (typeof SAVE_HEIGHTS)[number]

export const DEFAULT_GLOBAL_CAP: SaveHeight = 1080

const GLOBAL_CAP_KEY = 'youtube.save_max_height'
const userCapKey = (userId: string) => `youtube.save_max_height.${userId}`
const USER_PREF_KEY = 'youtube.save_quality'

function asHeight(v: unknown): SaveHeight | null {
  const n = typeof v === 'number' ? v : Number(v)
  return (SAVE_HEIGHTS as readonly number[]).includes(n) ? (n as SaveHeight) : null
}

/** Admin global cap (falls back to the default). */
export async function getGlobalCap(): Promise<SaveHeight> {
  return asHeight(await getAppSetting(GLOBAL_CAP_KEY)) ?? DEFAULT_GLOBAL_CAP
}

/** Admin per-user cap override, or null when unset (→ global default applies). */
export async function getUserCapOverride(userId: string): Promise<SaveHeight | null> {
  return asHeight(await getAppSetting(userCapKey(userId)))
}

/** The cap that actually applies to a user: their override, else the global cap. */
export async function getEffectiveCap(userId: string): Promise<SaveHeight> {
  return (await getUserCapOverride(userId)) ?? (await getGlobalCap())
}

/** The user's own preferred Save height, or null if they haven't chosen one. */
export async function getUserPreference(userId: string): Promise<SaveHeight | null> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, USER_PREF_KEY)))
    .limit(1)
  if (!row) return null
  try { return asHeight(JSON.parse(row.value)) } catch { return null }
}
