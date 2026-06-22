/**
 * Memory recall — entity-first deterministic pass, then vector semantic pass.
 *
 * Entity-first (v2 wiki pattern, proven to beat pure cosine for named-person recall):
 *   Tokenize the incoming prompt → case-insensitive match against entities.name + aliases
 *   → load ALL active memories linked to matched entities regardless of cosine score.
 *   This guarantees "would Artie like this?" surfaces Artie's facts even after months of silence.
 *
 * Vector pass:
 *   Cosine search over the remaining non-entity memories for thematic relevance.
 *
 * Scoring (Generative Agents-inspired):
 *   durable memories: no recency decay (recency = 1)
 *   episodic memories: score = 0.7·cosine + 0.2·importanceNorm + 0.1·recency
 *
 * Prompt budget:
 *   Output is capped at PROMPT_CHAR_BUDGET characters, sectioned into:
 *   "Core facts" (pinned/durable identity) | "People" (entity facts) | "Remembered context" (episodic)
 *
 * Usage tracking:
 *   Recalled memory ids get a background uses++ / lastUsedAt=now update (fire-and-forget).
 */

import { embed, cosineSimilarity } from '@/llm/embed'
import { db } from '@/db'
import { memories, entities, memoryEpisodes } from '@/db/schema'
import { and, eq, isNull, or, inArray, desc, sql, count } from 'drizzle-orm'

// ─── Config ───────────────────────────────────────────────────────────────────

const TOP_K_VECTOR = 5          // max non-entity memories from vector pass
const TOP_K_EPISODES = 1        // max episode summaries to include
const PROMPT_CHAR_BUDGET = 1200 // max characters for the injected memory block

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScoredMemory {
  id: string
  text: string
  category: string
  importance: number
  pinned: boolean
  tier: string
  entityId: string | null
  score: number
}

// ─── Scope helpers ────────────────────────────────────────────────────────────

function memoryScopeWhere(userId: string, characterId: string | null) {
  return or(
    and(eq(memories.userId, userId), isNull(memories.characterId)),
    characterId
      ? and(eq(memories.userId, userId), eq(memories.characterId, characterId))
      : undefined,
    characterId
      ? and(isNull(memories.userId), eq(memories.characterId, characterId))
      : undefined,
  )
}

function entityScopeWhere(userId: string, characterId: string | null) {
  return or(
    and(eq(entities.userId, userId), isNull(entities.characterId)),
    characterId
      ? and(eq(entities.userId, userId), eq(entities.characterId, characterId))
      : undefined,
    characterId
      ? and(isNull(entities.userId), eq(entities.characterId, characterId))
      : undefined,
  )
}

// ─── Token helper ─────────────────────────────────────────────────────────────

/** Very rough tokenizer: split on whitespace + common punctuation, lowercase. */
function promptTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,.'";:!?()\[\]{}<>]+/)
      .filter((t) => t.length >= 2),
  )
}

// ─── Main recall ─────────────────────────────────────────────────────────────

export async function countActiveMemories(userId: string, characterId: string | null): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(memories)
    .where(and(memoryScopeWhere(userId, characterId), eq(memories.status, 'active')))
  return row?.n ?? 0
}

export async function recallMemories(
  prompt: string,
  userId: string,
  characterId: string | null,
  precomputedEmbedding?: number[],
): Promise<ScoredMemory[]> {
  // Load up to 150 candidates — most important/pinned first — so cosine scoring
  // stays O(constant) instead of growing as the memory sweep accumulates entries.
  const rows = await db
    .select()
    .from(memories)
    .where(and(memoryScopeWhere(userId, characterId), eq(memories.status, 'active')))
    .orderBy(desc(memories.pinned), desc(memories.importance))
    .limit(150)

  if (rows.length === 0) return []

  // Load entities for this scope (needed for entity pass)
  const allEntities = await db
    .select()
    .from(entities)
    .where(entityScopeWhere(userId, characterId))

  const tokens = promptTokens(prompt)

  // ── Entity pass (deterministic) ──────────────────────────────────────────

  // Map alias → entityId for fast lookup
  const aliasToEntityId = new Map<string, string>()
  for (const e of allEntities) {
    aliasToEntityId.set(e.name.toLowerCase(), e.id)
    try {
      const aliases = JSON.parse(e.aliases) as string[]
      for (const a of aliases) aliasToEntityId.set(a.toLowerCase(), e.id)
    } catch { /* ignore */ }
  }

  // Find entity ids referenced by the prompt
  const matchedEntityIds = new Set<string>()
  for (const token of tokens) {
    const eid = aliasToEntityId.get(token)
    if (eid) matchedEntityIds.add(eid)
  }

  // Collect memories linked to matched entities
  const entityMemoryIds = new Set<string>()
  const entityMemories: ScoredMemory[] = []

  if (matchedEntityIds.size > 0) {
    for (const row of rows) {
      if (row.entityId && matchedEntityIds.has(row.entityId)) {
        entityMemoryIds.add(row.id)
        entityMemories.push({
          id: row.id,
          text: row.text,
          category: row.category ?? 'fact',
          importance: row.importance ?? 5,
          pinned: row.pinned ?? false,
          tier: row.tier ?? 'episodic',
          entityId: row.entityId,
          score: 1.0, // entity match gets top score
        })
      }
    }

    // Also update lastSeenAt for matched entities
    const entityIdArr = [...matchedEntityIds]
    if (entityIdArr.length > 0) {
      db.update(entities)
        .set({ lastSeenAt: new Date(), updatedAt: new Date() })
        .where(inArray(entities.id, entityIdArr))
        .catch(() => {})
    }
  }

  // ── Vector pass ───────────────────────────────────────────────────────────

  const promptEmbedding = precomputedEmbedding ?? await embed(prompt)
  const now = Date.now()

  const vectorMemories: ScoredMemory[] = []

  for (const row of rows) {
    if (entityMemoryIds.has(row.id)) continue // already in entity pass
    if (!row.embedding) continue

    let cosine = 0
    try {
      cosine = cosineSimilarity(promptEmbedding, JSON.parse(row.embedding) as number[])
    } catch {
      continue
    }

    const ageDays = row.createdAt ? (now - row.createdAt.getTime()) / 86_400_000 : 0
    // Durable memories: no recency decay. Episodic: standard decay.
    const recency = row.tier === 'durable' ? 1.0 : 1 / (1 + ageDays * 0.05)
    const importanceNorm = (row.importance ?? 5) / 10

    const score = 0.7 * cosine + 0.2 * importanceNorm + 0.1 * recency

    vectorMemories.push({
      id: row.id,
      text: row.text,
      category: row.category ?? 'fact',
      importance: row.importance ?? 5,
      pinned: row.pinned ?? false,
      tier: row.tier ?? 'episodic',
      entityId: row.entityId ?? null,
      score,
    })
  }

  // Always include pinned (durable identity facts)
  const pinned = vectorMemories.filter((m) => m.pinned)

  // Top-K non-pinned by score (filter out noise)
  const topK = vectorMemories
    .filter((m) => !m.pinned && m.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K_VECTOR)

  // ── Merge ─────────────────────────────────────────────────────────────────

  const all = [...entityMemories, ...pinned, ...topK]

  // Update usage stats in the background — one batched SQL statement, never blocks the SSE stream
  const recalledIds = all.map((m) => m.id)
  if (recalledIds.length > 0) {
    db.update(memories)
      .set({ uses: sql`${memories.uses} + 1`, lastUsedAt: new Date() })
      .where(inArray(memories.id, recalledIds))
      .catch(() => {})
  }

  return all
}

// ─── Episode recall ───────────────────────────────────────────────────────────

/** Retrieve the most relevant episode summaries for the current prompt. */
async function recallEpisodes(
  promptEmbedding: number[],
  userId: string,
  characterId: string | null,
): Promise<string[]> {
  const rows = await db
    .select()
    .from(memoryEpisodes)
    .where(
      and(
        eq(memoryEpisodes.userId, userId),
        characterId ? eq(memoryEpisodes.characterId, characterId) : isNull(memoryEpisodes.characterId),
      ),
    )
    .orderBy(desc(memoryEpisodes.createdAt))
    .limit(20) // examine recent 20 for relevance

  const scored = rows
    .filter((r) => r.embedding)
    .map((r) => {
      let cosine = 0
      try { cosine = cosineSimilarity(promptEmbedding, JSON.parse(r.embedding!) as number[]) } catch { /* */ }
      return { summary: r.summary, cosine }
    })
    .filter((r) => r.cosine > 0.3)
    .sort((a, b) => b.cosine - a.cosine)
    .slice(0, TOP_K_EPISODES)

  return scored.map((r) => r.summary)
}

// ─── Format for prompt injection ─────────────────────────────────────────────

export async function formatMemoriesForPrompt(
  mems: ScoredMemory[],
  userId: string,
  characterId: string | null,
  promptEmbedding?: number[],
): Promise<string | null> {
  if (mems.length === 0) return null

  const coreFacts = mems.filter((m) => m.pinned || m.tier === 'durable')
  const entityFacts = mems.filter((m) => !m.pinned && m.tier !== 'durable' && m.entityId)
  const contextFacts = mems.filter((m) => !m.pinned && m.tier !== 'durable' && !m.entityId)

  const lines: string[] = [
    '[Background context about the user. Use ONLY when directly relevant to what the user just asked. Never mention, reference, or hint at these facts unprompted — especially not in greetings or small talk. Do not say "I know you like X" or "since you enjoy Y". Wait for the user to raise a topic before using any of this.]',
  ]

  if (coreFacts.length > 0) {
    lines.push('Core facts:')
    for (const m of coreFacts) lines.push(`- ${m.text}`)
  }

  if (entityFacts.length > 0) {
    lines.push('People & places:')
    for (const m of entityFacts) lines.push(`- ${m.text}`)
  }

  if (contextFacts.length > 0) {
    lines.push('Remembered context:')
    for (const m of contextFacts) lines.push(`- ${m.text}`)
  }

  // Include relevant episode summaries if we have an embedding
  if (promptEmbedding) {
    const episodes = await recallEpisodes(promptEmbedding, userId, characterId)
    if (episodes.length > 0) {
      lines.push('Past conversations:')
      for (const e of episodes) lines.push(`- ${e}`)
    }
  }

  const full = lines.join('\n')
  // Enforce prompt budget — truncate gracefully at a line boundary
  if (full.length <= PROMPT_CHAR_BUDGET) return full

  const truncated: string[] = []
  let budget = PROMPT_CHAR_BUDGET
  for (const line of lines) {
    if (budget <= 0) break
    truncated.push(line)
    budget -= line.length + 1
  }
  return truncated.join('\n')
}
