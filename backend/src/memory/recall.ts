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

import { embed, cosineSimilarity, cachedVector } from '@/llm/embed'
import { db } from '@/db'
import { memories, entities, memoryEpisodes } from '@/db/schema'
import { and, eq, isNull, or, inArray, desc, gte, sql, count } from 'drizzle-orm'

// ─── Config ───────────────────────────────────────────────────────────────────

const TOP_K_VECTOR = 5          // max non-entity episodic memories from vector pass
const TOP_K_DURABLE = 4         // max non-pinned durable memories (lower gate, see below)
const TOP_K_ENTITY = 12         // max entity-linked memories (most-important first)
const TOP_K_EPISODES = 1        // max episode summaries to include
const PROMPT_CHAR_BUDGET = 2000 // max characters for the injected memory block

// "Open threads": recent goal/event/project/state memories the companion may
// proactively ask about once ("how'd the interview go?"). This is the deliberate
// carve-out from the anti-parroting rule — unprompted follow-ups about the user's
// life are the single most human behavior, and were previously forbidden outright.
const OPEN_THREAD_DAYS = 7
const OPEN_THREAD_MAX = 3
const OPEN_THREAD_CATEGORIES: ('goal' | 'event' | 'project' | 'state')[] = ['goal', 'event', 'project', 'state']

// Minimum RAW cosine for a non-pinned memory to enter the vector pass at all.
// The blended score alone was no filter: importance (0.2·imp/10) + durable recency
// (0.1) clear the old 0.12 threshold at cosine 0, so the top-5 memories were
// injected on every turn regardless of relevance — even for "hi". Gate on actual
// semantic similarity first. Tuned for nomic-embed-text, where unrelated English
// sentences typically sit ~0.3–0.45 and genuinely related ones ~0.6+.
const VECTOR_MIN_COSINE = 0.55

// Durable non-pinned memories (stable preferences: "dislikes cilantro", "is
// vegetarian") get a LOWER gate. Measured under nomic-embed-text: a dinner
// question scores ~0.38 against "dislikes cilantro" and a steakhouse request
// ~0.41 against "is vegetarian" — the 0.55 gate meant durable preferences were
// stored but never recalled. Unrelated pairs measure ~0.30–0.36, so 0.37 is the
// separating line (thin margin — guarded by scripts/eval/memory-eval.ts). Only
// durable rows get this: episodic memories at 0.37 are noise, durables are few
// (judge marks little durable) and capped at TOP_K_DURABLE.
const DURABLE_MIN_COSINE = 0.37

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
    // Household scope (userId null, characterId null): facts every family member
    // shares — the dog's name, the wifi, the address. Written by the judge when
    // a fact is tagged household.
    and(isNull(memories.userId), isNull(memories.characterId)),
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

// ─── Entity matching (exported for per-turn cache validation) ─────────────────

// The deterministic entity pass is cheap enough to run EVERY turn (tokenize +
// Map lookups) once the entity list is cached — it's the trigger that busts a
// stale conversation memory block the moment a new person/place is mentioned.
const _entityCache = new Map<string, { rows: (typeof entities.$inferSelect)[]; expiresAt: number }>()
const ENTITY_CACHE_TTL_MS = 60_000

async function loadScopeEntities(userId: string, characterId: string | null) {
  const key = `${userId}:${characterId ?? ''}`
  const cached = _entityCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.rows
  const rows = await db
    .select()
    .from(entities)
    .where(entityScopeWhere(userId, characterId))
  _entityCache.set(key, { rows, expiresAt: Date.now() + ENTITY_CACHE_TTL_MS })
  return rows
}

/** Invalidate the cached entity list (call after the judge writes new entities). */
export function invalidateEntityCache(userId: string): void {
  for (const key of _entityCache.keys()) {
    if (key.startsWith(`${userId}:`)) _entityCache.delete(key)
  }
}

function buildAliasIndex(rows: (typeof entities.$inferSelect)[]): Map<string, string> {
  const aliasToEntityId = new Map<string, string>()
  for (const e of rows) {
    aliasToEntityId.set(e.name.toLowerCase(), e.id)
    try {
      const aliases = JSON.parse(e.aliases) as string[]
      for (const a of aliases) aliasToEntityId.set(a.toLowerCase(), e.id)
    } catch { /* ignore */ }
  }
  return aliasToEntityId
}

/** Entity ids referenced by this prompt (deterministic token match, cached entities). */
export async function matchPromptEntities(
  prompt: string,
  userId: string,
  characterId: string | null,
): Promise<Set<string>> {
  const rows = await loadScopeEntities(userId, characterId)
  if (rows.length === 0) return new Set()
  const aliasToEntityId = buildAliasIndex(rows)
  const matched = new Set<string>()
  for (const token of promptTokens(prompt)) {
    const eid = aliasToEntityId.get(token)
    if (eid) matched.add(eid)
  }
  return matched
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
  precomputedEntityIds?: Set<string>,
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

  // ── Entity pass (deterministic) ──────────────────────────────────────────

  const matchedEntityIds = precomputedEntityIds ?? await matchPromptEntities(prompt, userId, characterId)

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

    const vec = cachedVector(`${row.id}:${row.updatedAt?.getTime() ?? 0}`, row.embedding)
    if (!vec) continue
    const cosine = cosineSimilarity(promptEmbedding, vec)

    // Non-pinned memories must be semantically relevant to the prompt to be
    // considered at all. Pinned rows bypass this (they're always included below);
    // durable rows use the lower preference gate (see DURABLE_MIN_COSINE).
    const minCosine = row.tier === 'durable' ? DURABLE_MIN_COSINE : VECTOR_MIN_COSINE
    if (!row.pinned && cosine < minCosine) continue

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

  // Non-pinned durables (preferences) and episodic memories are capped
  // separately, so a handful of relevant stable preferences can't be crowded out
  // by fresher episodic rows (or vice versa).
  const topDurable = vectorMemories
    .filter((m) => !m.pinned && m.tier === 'durable')
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K_DURABLE)

  const topK = vectorMemories
    .filter((m) => !m.pinned && m.tier !== 'durable' && m.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K_VECTOR)

  // ── Merge ─────────────────────────────────────────────────────────────────

  // Entity memories are capped most-important-first so one heavily-documented
  // person can't blow the prompt budget and truncate every later section.
  const cappedEntity = entityMemories
    .sort((a, b) => b.importance - a.importance)
    .slice(0, TOP_K_ENTITY)

  const all = [...cappedEntity, ...pinned, ...topDurable, ...topK]

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

/** Recent goal/event/project/state memories eligible for a proactive follow-up. */
async function recallOpenThreads(
  userId: string,
  characterId: string | null,
  excludeIds: Set<string>,
): Promise<string[]> {
  const cutoff = new Date(Date.now() - OPEN_THREAD_DAYS * 86_400_000)
  const rows = await db
    .select({ id: memories.id, text: memories.text })
    .from(memories)
    .where(
      and(
        memoryScopeWhere(userId, characterId),
        eq(memories.status, 'active'),
        inArray(memories.category, OPEN_THREAD_CATEGORIES),
        gte(memories.createdAt, cutoff),
      ),
    )
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(OPEN_THREAD_MAX + 3)
  return rows.filter((r) => !excludeIds.has(r.id)).slice(0, OPEN_THREAD_MAX).map((r) => r.text)
}

export async function formatMemoriesForPrompt(
  mems: ScoredMemory[],
  userId: string,
  characterId: string | null,
  promptEmbedding?: number[],
): Promise<string | null> {
  const openThreads = await recallOpenThreads(userId, characterId, new Set(mems.map((m) => m.id))).catch(() => [] as string[])
  if (mems.length === 0 && openThreads.length === 0) return null

  const coreFacts = mems.filter((m) => m.pinned || m.tier === 'durable')
  const entityFacts = mems.filter((m) => !m.pinned && m.tier !== 'durable' && m.entityId)
  const contextFacts = mems.filter((m) => !m.pinned && m.tier !== 'durable' && !m.entityId)

  const lines: string[] = [
    '[Background context about the user. Use ONLY when directly relevant to what the user just asked. Never mention, reference, or hint at these facts unprompted — especially not in greetings or small talk. Do not say "I know you like X" or "since you enjoy Y". Wait for the user to raise a topic before using any of this. The ONE exception is the "Open threads" section, when present.]',
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

  if (openThreads.length > 0) {
    lines.push('Open threads — recent things going on in their life. You MAY bring one up naturally, once, when there\'s a lull or a greeting ("how\'d the interview go?"). Don\'t force it if they\'re focused on something else, and never repeat one they\'ve already updated you on:')
    for (const t of openThreads) lines.push(`- ${t}`)
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
    if (line.length + 1 > budget) break
    truncated.push(line)
    budget -= line.length + 1
  }
  return truncated.join('\n')
}
