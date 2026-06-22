/**
 * Memory maintenance — lifecycle management for the episodic tier.
 *
 * Run by the idle sweep on a slower schedule (hourly). Never touches durable memories.
 *
 * What it does:
 *   1. Compute decay score per episodic memory (Generative Agents exp-decay formula).
 *   2. Archive episodic memories below the score threshold AND unused for minAgeDays.
 *   3. Enforce a per-scope soft cap on active episodic count (archive lowest-scoring).
 *   4. Enforce a retention cap on memory_episodes (oldest rows beyond cap get deleted).
 *
 * Nothing is hard-deleted — status=archived is the floor. Durable memories are untouched.
 */

import { db } from '@/db'
import { memories, memoryEpisodes } from '@/db/schema'
import { and, eq, isNull, desc, inArray } from 'drizzle-orm'
import { logger } from '@/lib/logger'

// ─── Tuning constants ─────────────────────────────────────────────────────────

// Generative Agents decay: score = decay_factor ^ hours_since_last_used
const DECAY_FACTOR = 0.995

// Archive an episodic memory if decayScore < this AND it hasn't been used in minAgeDays
const ARCHIVE_SCORE_THRESHOLD = 0.10
const ARCHIVE_MIN_AGE_DAYS = 30

// Max active episodic memories per scope before the bottom-scorers get archived
const EPISODIC_CAP_PER_SCOPE = 200

// Max stored episodes per (userId, characterId) pair
const EPISODE_CAP = 50

// ─── Scoring ──────────────────────────────────────────────────────────────────

function decayScore(
  importance: number,
  uses: number,
  lastUsedAt: Date | null,
  createdAt: Date,
): number {
  const referenceDate = lastUsedAt ?? createdAt
  const hoursSince = (Date.now() - referenceDate.getTime()) / 3_600_000
  const recency = Math.pow(DECAY_FACTOR, hoursSince)           // 0.995^hours ≈ GA formula
  const usageBoost = 1 + Math.log1p(uses) * 0.1               // gentle log boost for frequently recalled
  const importanceNorm = importance / 10
  return recency * importanceNorm * usageBoost
}

// ─── Scope helpers ────────────────────────────────────────────────────────────

type Scope = { userId: string | null; characterId: string | null }

function memScopeWhere(scope: Scope) {
  return and(
    scope.userId ? eq(memories.userId, scope.userId) : isNull(memories.userId),
    scope.characterId ? eq(memories.characterId, scope.characterId) : isNull(memories.characterId),
    eq(memories.tier, 'episodic'),
    eq(memories.status, 'active'),
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export interface MaintenanceResult {
  scopesProcessed: number
  memoriesArchived: number
  episodesDeleted: number
}

export async function runMaintenance(): Promise<MaintenanceResult> {
  const result: MaintenanceResult = { scopesProcessed: 0, memoriesArchived: 0, episodesDeleted: 0 }

  // Discover all distinct scopes that have active episodic memories
  const scopeRows = await db
    .selectDistinct({ userId: memories.userId, characterId: memories.characterId })
    .from(memories)
    .where(and(eq(memories.tier, 'episodic'), eq(memories.status, 'active')))

  for (const scope of scopeRows) {
    result.scopesProcessed++
    const archived = await maintainScope(scope)
    result.memoriesArchived += archived
  }

  // Episode retention cap — per (userId, characterId) pair
  const episopeScopes = await db
    .selectDistinct({ userId: memoryEpisodes.userId, characterId: memoryEpisodes.characterId })
    .from(memoryEpisodes)

  for (const s of episopeScopes) {
    const episodesDeleted = await trimEpisodes(s.userId, s.characterId)
    result.episodesDeleted += episodesDeleted
  }

  if (result.memoriesArchived > 0 || result.episodesDeleted > 0) {
    logger.info(
      `[memory:maintenance] scopes=${result.scopesProcessed} archived=${result.memoriesArchived} episodes_deleted=${result.episodesDeleted}`,
    )
  }

  return result
}

async function maintainScope(scope: Scope): Promise<number> {
  const rows = await db
    .select()
    .from(memories)
    .where(memScopeWhere(scope))

  if (rows.length === 0) return 0

  // Score each row
  const scored = rows.map((m) => ({
    id: m.id,
    score: decayScore(m.importance, m.uses, m.lastUsedAt, m.createdAt),
    ageDays: (Date.now() - (m.lastUsedAt ?? m.createdAt).getTime()) / 86_400_000,
  }))

  // Sort descending so we can cap by index
  scored.sort((a, b) => b.score - a.score)

  const toArchive = new Set<string>()

  // Rule 1: archive below threshold AND old enough
  for (const s of scored) {
    if (s.score < ARCHIVE_SCORE_THRESHOLD && s.ageDays >= ARCHIVE_MIN_AGE_DAYS) {
      toArchive.add(s.id)
    }
  }

  // Rule 2: enforce cap (archive lowest-scoring beyond cap)
  const activeAfterThreshold = scored.filter((s) => !toArchive.has(s.id))
  if (activeAfterThreshold.length > EPISODIC_CAP_PER_SCOPE) {
    const excess = activeAfterThreshold.slice(EPISODIC_CAP_PER_SCOPE)
    for (const s of excess) toArchive.add(s.id)
  }

  if (toArchive.size === 0) return 0

  const ids = [...toArchive]
  await db
    .update(memories)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(and(eq(memories.status, 'active'), inArray(memories.id, ids)))

  return ids.length
}

async function trimEpisodes(userId: string, characterId: string | null): Promise<number> {
  const rows = await db
    .select({ id: memoryEpisodes.id })
    .from(memoryEpisodes)
    .where(
      and(
        eq(memoryEpisodes.userId, userId),
        characterId ? eq(memoryEpisodes.characterId, characterId) : isNull(memoryEpisodes.characterId),
      ),
    )
    .orderBy(desc(memoryEpisodes.createdAt))

  if (rows.length <= EPISODE_CAP) return 0

  const toDelete = rows.slice(EPISODE_CAP).map((r) => r.id)

  for (const id of toDelete) {
    await db.delete(memoryEpisodes).where(eq(memoryEpisodes.id, id))
  }

  return toDelete.length
}
