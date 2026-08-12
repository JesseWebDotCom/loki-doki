/**
 * Per-user knowledge paragraph (ChatGPT memory pattern).
 *
 * One compact "who this person is" paragraph per family member, regenerated as a
 * sleep-time job whenever the judge writes new facts for them, and injected at
 * the top of every memory block. Per-message vector recall is a lottery; this
 * paragraph guarantees every turn a coherent baseline picture of the user.
 *
 * Flow: the sweep calls markProfileDirty(userId) after a judge write, and
 * regenerateDirtyProfiles(model) on its maintenance cadence composes a fresh
 * paragraph from the user's durable facts + recent episodes on the fast model.
 */

import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { memories, memoryProfiles, memoryEpisodes, users } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import { invalidateMemoryBlocksForUser } from './blockCache'
import { logger } from '@/lib/logger'

const dirtyUsers = new Set<string>()

const PROFILE_FACT_LIMIT = 30
const PROFILE_EPISODE_LIMIT = 5
const PROFILE_MAX_CHARS = 900

const PROFILE_PROMPT =
  'Write ONE paragraph (at most 120 words, plain prose) describing this person for an assistant that talks with them daily: who they are, the people and things that matter to them, their stable preferences, and anything ongoing in their life. Only use the facts given. No headers, no bullet points, no speculation. Reply with ONLY the paragraph.'

export function markProfileDirty(userId: string): void {
  dirtyUsers.add(userId)
}

/** Regenerate the knowledge paragraph for every user the judge touched since the
 *  last pass. Called from the sweep's maintenance cadence — never the request path. */
export async function regenerateDirtyProfiles(): Promise<void> {
  if (dirtyUsers.size === 0) return
  const batch = [...dirtyUsers]
  dirtyUsers.clear()

  for (const userId of batch) {
    try {
      await regenerateProfile(userId)
    } catch (err) {
      logger.warn(`[memory:profile] regeneration failed for user=${userId}: ${err}`)
      dirtyUsers.add(userId) // retry next pass
    }
  }
}

async function regenerateProfile(userId: string): Promise<void> {
  const [userRow] = await db
    .select({ nickname: users.nickname, firstName: users.firstName })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!userRow) return
  const name = userRow.nickname?.trim() || userRow.firstName?.trim() || 'this person'

  const facts = await db
    .select({ text: memories.text, tier: memories.tier, category: memories.category })
    .from(memories)
    .where(and(
      eq(memories.userId, userId),
      isNull(memories.characterId),
      eq(memories.status, 'active'),
    ))
    .orderBy(desc(memories.pinned), desc(memories.importance), desc(memories.updatedAt))
    .limit(PROFILE_FACT_LIMIT)

  if (facts.length < 3) return // not enough signal for a paragraph yet

  const episodes = await db
    .select({ summary: memoryEpisodes.summary })
    .from(memoryEpisodes)
    .where(eq(memoryEpisodes.userId, userId))
    .orderBy(desc(memoryEpisodes.createdAt))
    .limit(PROFILE_EPISODE_LIMIT)

  const material = [
    `Name: ${name}`,
    'Facts:',
    ...facts.map((f) => `- ${f.text}`),
    ...(episodes.length > 0 ? ['Recent conversations:', ...episodes.map((e) => `- ${e.summary}`)] : []),
  ].join('\n')

  const fastModel = await getFastModel()
  const res = await ollamaChat(
    fastModel,
    [
      { role: 'system', content: PROFILE_PROMPT },
      { role: 'user', content: material },
    ],
    undefined,
    { temperature: 0.3, num_predict: 220 },
    undefined,
    30_000,
  )
  const paragraph = res.message.content?.trim()
  if (!paragraph || paragraph.length < 40) return

  const now = new Date()
  await db
    .insert(memoryProfiles)
    .values({ id: crypto.randomUUID(), userId, paragraph: paragraph.slice(0, PROFILE_MAX_CHARS), updatedAt: now })
    .onConflictDoUpdate({
      target: memoryProfiles.userId,
      set: { paragraph: paragraph.slice(0, PROFILE_MAX_CHARS), updatedAt: now },
    })

  _profileCache.delete(userId)
  invalidateMemoryBlocksForUser(userId)
  logger.info(`[memory:profile] refreshed knowledge paragraph for user=${userId} (${paragraph.length} chars)`)
}

// ── Read path (recall injection) ─────────────────────────────────────────────

const _profileCache = new Map<string, { paragraph: string | null; expiresAt: number }>()
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000

/** The user's knowledge paragraph, or null when none exists yet. Cached in-process. */
export async function getKnowledgeProfile(userId: string): Promise<string | null> {
  const cached = _profileCache.get(userId)
  if (cached && cached.expiresAt > Date.now()) return cached.paragraph
  const [row] = await db
    .select({ paragraph: memoryProfiles.paragraph })
    .from(memoryProfiles)
    .where(eq(memoryProfiles.userId, userId))
    .limit(1)
  const paragraph = row?.paragraph ?? null
  _profileCache.set(userId, { paragraph, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS })
  return paragraph
}
