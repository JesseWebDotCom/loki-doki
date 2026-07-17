// Per-user, per-companion voice customization (design: keen-percolating-swan).
//
// Stored in the generic userPreferences KV table (no schema change) under a
// dynamic per-character key, following the same convention as
// `videos.save_quality.<source>` (lib/videos/quality.ts). Every field is
// optional — absence means "inherit the character's/app's default" (see
// routes/tts.ts's resolution chain, which only consults this when the caller
// explicitly opts in via `applyUserVoicePrefs`).

import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences } from '@/db/schema'

export interface VoicePrefs {
  voiceId?: string
  speechRate?: number
  pitchSemitones?: number
  hushed?: boolean
}

const keyFor = (characterId: string) => `voice.prefs.${characterId}`

export async function getVoicePrefs(userId: string, characterId: string): Promise<VoicePrefs | null> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, keyFor(characterId))))
    .limit(1)
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as VoicePrefs
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

export async function setVoicePrefs(userId: string, characterId: string, patch: VoicePrefs): Promise<VoicePrefs> {
  const existing = (await getVoicePrefs(userId, characterId)) ?? {}
  const next: VoicePrefs = { ...existing, ...patch }
  const now = new Date()
  const value = JSON.stringify(next)
  await db
    .insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId, key: keyFor(characterId), value, updatedAt: now })
    .onConflictDoUpdate({ target: [userPreferences.userId, userPreferences.key], set: { value, updatedAt: now } })
  return next
}
