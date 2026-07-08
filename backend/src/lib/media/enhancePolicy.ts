// Single household-wide "enhance downloaded videos" policy — NOT app-scoped. Governs every
// download app (YouTube now, the clipper later) so a user sets it once. Two tiers stack:
//   1. admin default — appSettings `media.enhance_default` (boolean, all users)
//   2. user override  — userPreferences `media.enhance_mode` ('default' | 'always' | 'never')
// Mirrors the tier pattern in lib/youtube/quality.ts.

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences } from '@/db/schema'
import { getAppSetting } from '@/lib/settings'

export type EnhanceMode = 'default' | 'always' | 'never'

export const ENHANCE_DEFAULT_KEY = 'media.enhance_default'
export const ENHANCE_MODE_KEY = 'media.enhance_mode'

/** Admin household default (off unless an admin turns it on). */
export async function getEnhanceDefault(): Promise<boolean> {
  return (await getAppSetting(ENHANCE_DEFAULT_KEY)) === true
}

/** A user's own override (defaults to following the admin default). */
export async function getEnhanceMode(userId: string): Promise<EnhanceMode> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, ENHANCE_MODE_KEY)))
    .limit(1)
  if (!row) return 'default'
  try {
    const v = JSON.parse(row.value)
    return v === 'always' || v === 'never' ? v : 'default'
  } catch { return 'default' }
}

/** Whether saved video for this user should be background-enhanced. */
export async function shouldEnhance(userId: string): Promise<boolean> {
  const mode = await getEnhanceMode(userId)
  if (mode === 'always') return true
  if (mode === 'never') return false
  return getEnhanceDefault()
}

// ── Per-source overrides ────────────────────────────────────────────────────────
// A third, more specific tier layered on the household policy: a user (or the admin
// default) can pin enhancement on/off for ONE source (youtube/tiktok/vimeo/reddit)
// without touching the household-wide setting. Unset (= 'default' / absent) falls
// through to the household tiers above, so existing behavior is unchanged until
// someone actually sets a per-source value.

export const enhanceModeKeyFor = (source: string) => `${ENHANCE_MODE_KEY}.${source}`
export const enhanceDefaultKeyFor = (source: string) => `${ENHANCE_DEFAULT_KEY}.${source}`

/** A user's per-source override ('default' = no override, follow household policy). */
export async function getEnhanceModeFor(userId: string, source: string): Promise<EnhanceMode> {
  const [row] = await db.select({ value: userPreferences.value }).from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, enhanceModeKeyFor(source))))
    .limit(1)
  if (!row) return 'default'
  try {
    const v = JSON.parse(row.value)
    return v === 'always' || v === 'never' ? v : 'default'
  } catch { return 'default' }
}

/** Admin per-source default: true/false when explicitly set, null = inherit household. */
export async function getEnhanceDefaultFor(source: string): Promise<boolean | null> {
  const v = await getAppSetting(enhanceDefaultKeyFor(source))
  return typeof v === 'boolean' ? v : null
}

/** Whether a saved video FROM THIS SOURCE should be background-enhanced for this user.
 *  Precedence: user per-source override → user household override → admin per-source
 *  default → admin household default. */
export async function shouldEnhanceFor(userId: string, source: string): Promise<boolean> {
  const sourceMode = await getEnhanceModeFor(userId, source)
  if (sourceMode === 'always') return true
  if (sourceMode === 'never') return false
  const mode = await getEnhanceMode(userId)
  if (mode === 'always') return true
  if (mode === 'never') return false
  const sourceDefault = await getEnhanceDefaultFor(source)
  if (sourceDefault != null) return sourceDefault
  return getEnhanceDefault()
}
