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
