/**
 * Memory judge — out-of-band, session-aware fact extraction (Letta "sleep-time" pattern).
 *
 * Called by the idle sweep AFTER a conversation goes quiet (user not typing).
 * Sees the FULL unprocessed span of the conversation, not just last 6 messages.
 * This is the core fix for the "rotting meat" problem: because the judge sees the
 * whole session it can distinguish a one-off curiosity query from a real preference.
 *
 * Two-phase approach (mirrors mem0 but with an explicit discard rule):
 *   Phase 1 — extract entities + candidate facts from the conversation text.
 *   Phase 2 — for each fact, cosine-filter existing memories and call a dedup round.
 *   Entities are upserted by name match (deterministic, no embedding needed).
 */

import { structuredCall } from '@/llm/structured'
import { embed, cosineSimilarity } from '@/llm/embed'
import { db } from '@/db'
import { memories, entities } from '@/db/schema'
import { and, eq, isNull } from 'drizzle-orm'

// ─── Types ────────────────────────────────────────────────────────────────────

type MemoryCategory =
  | 'person' | 'place' | 'thing' | 'preference' | 'identity'
  | 'event' | 'project' | 'goal' | 'relationship' | 'fact'

type MemoryTier = 'durable' | 'episodic'
type MemoryAction = 'ADD' | 'UPDATE' | 'DELETE' | 'NO_CHANGE'

interface ExtractedEntity {
  name: string
  kind: 'person' | 'place' | 'thing' | 'org'
  aliases: string[]     // lowercase variants, e.g. ["artie", "brother", "art"]
  importance: number    // 1–10
}

interface ExtractedFact {
  text: string
  category: MemoryCategory
  tier: MemoryTier
  importance: number    // 1–10
  entityName: string | null   // name of entity this fact is about, if any
}

interface DedupeDecision {
  action: MemoryAction
  id: string | null       // existing memory id (for UPDATE/DELETE)
  text: string | null     // merged text (for UPDATE)
}

export interface JudgeResult {
  entitiesUpserted: number
  factsAdded: number
  factsUpdated: number
  factsSuperseded: number
  factsNoChange: number
}

// ─── Phase 1 prompt: extract from conversation ────────────────────────────────

const EXTRACT_PROMPT = `You are a long-term memory manager for a personal AI. Review the conversation below and extract:
1. Named entities personally relevant to the user (people, places, things they own/care about).
2. Durable facts worth remembering long-term.

CRITICAL — DISCARD these, do NOT extract:
- Questions the user asked or information they looked up (one-off curiosity)
- Temporary states, moods, feelings ("I'm tired", "I'm excited today")
- Tasks, to-dos, or things to do later
- Facts about the world that don't reveal anything about the user
- Anything the user asked about as a passing question with no personal relevance
- Meta-statements about the user's relationship to real-time/transient data — "the user knows the current date", "the user is unsure about the date", "the user asked about the weather". The current date/time/weather/prices are not facts about the user, and neither is whether they currently know them.
- Trivially-true or contentless observations ("the user said hi", "the user is chatting", "the user wants help")

PERSIST these:
- Stable facts about the user's identity, life, relationships, preferences
- People, places, or things personally important to them
- Long-running projects, goals, or aspirations
- Corrections or updates to previously stated facts

Category options: person, place, thing, preference, identity, event, project, goal, relationship, fact
Tier:
- "durable" = identity, relationship, person, preference — these facts should live forever
- "episodic" = event, project, goal, thing, place, fact — subject to decay over time
Importance 1–10: identity/relationship=9–10, strong preference=7–8, project/goal=5–6, minor fact=3–4

Examples of what to DISCARD vs PERSIST:
- "How long until bacteria grows on meat left out?" → DISCARD (one-off question, not about the user)
- "I forgot to charge my car" → PERSIST entity:car, fact:"user has an electric car" (inferred)
- "My brother Artie loves horror movies" → PERSIST entity:Artie(person,aliases:["artie","brother"]), fact:"Artie loves horror movies"
- "I hate cilantro" → PERSIST fact:"user dislikes cilantro" (category:preference, tier:durable)
- "What year was the Eiffel Tower built?" → DISCARD (trivia question)
- "What's today's date?" → DISCARD entirely — do NOT store "user is unsure about the date" or "user knows the date"; nothing durable was revealed
- "I'm building a home theater in my basement" → PERSIST fact:"user is building a home theater" (goal)
- "I'm so stressed today" → DISCARD (temporary mood)
- "I've been a vegetarian for 10 years" → PERSIST fact:"user is vegetarian" (identity)

Return ONLY a JSON object in this exact shape (empty arrays if nothing to extract):
{
  "entities": [
    { "name": "Artie", "kind": "person", "aliases": ["artie", "brother", "art"], "importance": 8 }
  ],
  "facts": [
    { "text": "user has an electric car", "category": "thing", "tier": "episodic", "importance": 5, "entityName": null },
    { "text": "Artie loves horror movies", "category": "preference", "tier": "durable", "importance": 7, "entityName": "Artie" }
  ]
}`

// ─── Phase 2 prompt: dedup against existing memories ─────────────────────────

const DEDUPE_PROMPT = `You manage a memory store. Given a new memory and similar existing memories, decide what to do.

New memory: "{new_memory}"

Existing similar memories:
{existing}

Respond with EXACTLY one JSON object — no other text:
{"action":"ADD"|"UPDATE"|"DELETE"|"NO_CHANGE","id":"<existing id or null>","text":"<merged text if UPDATE, else null>"}

- ADD: genuinely new information not captured in any existing memory
- UPDATE: new memory refines or extends an existing one — provide merged text
- DELETE: new memory directly contradicts/obsoletes an existing one
- NO_CHANGE: already captured well enough`

// ─── Scope helpers ────────────────────────────────────────────────────────────

function scopeWhere(userId: string, characterId: string | null) {
  return and(
    userId ? eq(memories.userId, userId) : isNull(memories.userId),
    characterId ? eq(memories.characterId, characterId) : isNull(memories.characterId),
  )
}

function entityScopeWhere(userId: string, characterId: string | null) {
  return and(
    userId ? eq(entities.userId, userId) : isNull(entities.userId),
    characterId ? eq(entities.characterId, characterId) : isNull(entities.characterId),
  )
}

// Derive tier from category (judge can override; this is the default mapping)
function categoryToTier(category: MemoryCategory): MemoryTier {
  const durable: MemoryCategory[] = ['identity', 'relationship', 'person', 'preference']
  return durable.includes(category) ? 'durable' : 'episodic'
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runJudge(
  _conversationId: string,
  userId: string,
  characterId: string | null,
  messages: Array<{ role: string; content: string }>,
  model: string,
): Promise<JudgeResult> {
  const result: JudgeResult = {
    entitiesUpserted: 0,
    factsAdded: 0,
    factsUpdated: 0,
    factsSuperseded: 0,
    factsNoChange: 0,
  }

  if (messages.length === 0) return result

  // Build conversation text for the judge (exclude system messages)
  const conversationText = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')

  // ── Phase 1: extract entities and candidate facts ─────────────────────────

  let extracted: { entities: ExtractedEntity[]; facts: ExtractedFact[] }
  try {
    extracted = await structuredCall<{ entities: ExtractedEntity[]; facts: ExtractedFact[] }>(
      model,
      conversationText,
      EXTRACT_PROMPT,
    )
    if (!Array.isArray(extracted?.entities)) extracted = { entities: [], facts: [] }
    if (!Array.isArray(extracted?.facts)) extracted.facts = []
  } catch {
    return result
  }

  if (extracted.entities.length === 0 && extracted.facts.length === 0) return result

  // Load existing entities for this scope
  const existingEntities = await db
    .select()
    .from(entities)
    .where(entityScopeWhere(userId, characterId))

  // ── Entity upsert (deterministic name/alias match, no embedding needed) ──

  const entityIdByName = new Map<string, string>() // canonical name (lower) → entity.id

  for (const e of existingEntities) {
    entityIdByName.set(e.name.toLowerCase(), e.id)
    try {
      const aliases = JSON.parse(e.aliases) as string[]
      for (const a of aliases) entityIdByName.set(a.toLowerCase(), e.id)
    } catch { /* ignore */ }
  }

  for (const e of extracted.entities) {
    const canonicalKey = e.name.toLowerCase()
    const existingId = entityIdByName.get(canonicalKey)
      ?? e.aliases.map((a) => entityIdByName.get(a.toLowerCase())).find(Boolean)

    const now = new Date()
    const allAliases = [...new Set([e.name.toLowerCase(), ...e.aliases.map((a) => a.toLowerCase())])]

    if (existingId) {
      // Update: merge aliases and refresh lastSeenAt / importance
      const existing = existingEntities.find((ex) => ex.id === existingId)!
      let existingAliases: string[] = []
      try { existingAliases = JSON.parse(existing.aliases) as string[] } catch { /* ignore */ }
      const mergedAliases = [...new Set([...existingAliases, ...allAliases])]

      await db
        .update(entities)
        .set({
          aliases: JSON.stringify(mergedAliases),
          importance: Math.max(existing.importance, e.importance),
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(entities.id, existingId))

      // Make sure all aliases map to this id for fact-linking below
      for (const alias of mergedAliases) entityIdByName.set(alias, existingId)
      entityIdByName.set(e.name.toLowerCase(), existingId)
    } else {
      // Insert new entity
      const newId = crypto.randomUUID()
      await db.insert(entities).values({
        id: newId,
        userId: userId || null,
        characterId: characterId || null,
        name: e.name,
        kind: e.kind,
        aliases: JSON.stringify(allAliases),
        importance: Math.min(10, Math.max(1, e.importance)),
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      for (const alias of allAliases) entityIdByName.set(alias, newId)
      entityIdByName.set(canonicalKey, newId)
    }

    result.entitiesUpserted++
  }

  // ── Phase 2: dedup each fact against existing memories ────────────────────

  // Load all active memories for this scope once
  const existingMemories = await db
    .select()
    .from(memories)
    .where(and(scopeWhere(userId, characterId), eq(memories.status, 'active')))

  // Keep the in-memory list fresh as we add rows within this batch
  const liveMemories = [...existingMemories]

  for (const fact of extracted.facts) {
    if (!fact.text?.trim()) continue

    const factEmbedding = await embed(fact.text)

    // Find semantically similar existing memories (wide net — LLM makes the final call)
    const similar = liveMemories
      .filter((m) => {
        if (!m.embedding) return false
        try {
          return cosineSimilarity(factEmbedding, JSON.parse(m.embedding) as number[]) > 0.5
        } catch {
          return false
        }
      })
      .slice(0, 5)

    let decision: DedupeDecision = { action: 'ADD', id: null, text: null }

    if (similar.length > 0) {
      const existingList = similar.map((m) => `[${m.id}] ${m.text}`).join('\n')
      const prompt = DEDUPE_PROMPT
        .replace('{new_memory}', fact.text)
        .replace('{existing}', existingList)

      try {
        decision = await structuredCall<DedupeDecision>(model, prompt)
        if (!decision.action) decision = { action: 'ADD', id: null, text: null }
      } catch {
        decision = { action: 'ADD', id: null, text: null }
      }
    }

    const now = new Date()
    const tier = fact.tier ?? categoryToTier(fact.category)
    const importance = Math.min(10, Math.max(1, fact.importance ?? 5))

    // Resolve entityId by matching entityName against the entity map
    let entityId: string | null = null
    if (fact.entityName) {
      entityId = entityIdByName.get(fact.entityName.toLowerCase()) ?? null
    }

    if (decision.action === 'NO_CHANGE') {
      result.factsNoChange++
    } else if (decision.action === 'DELETE' && decision.id) {
      // Soft-delete: mark superseded rather than hard-deleting (Zep bi-temporal pattern)
      await db
        .update(memories)
        .set({ status: 'superseded', updatedAt: now })
        .where(eq(memories.id, decision.id))
      // Remove from live list so subsequent facts in this batch don't match it
      const idx = liveMemories.findIndex((m) => m.id === decision.id)
      if (idx !== -1) liveMemories.splice(idx, 1)
      result.factsSuperseded++
    } else if (decision.action === 'UPDATE' && decision.id && decision.text) {
      const updatedEmbedding = await embed(decision.text)
      await db
        .update(memories)
        .set({
          text: decision.text,
          embedding: JSON.stringify(updatedEmbedding),
          tier,
          importance,
          entityId,
          updatedAt: now,
        })
        .where(eq(memories.id, decision.id))
      // Refresh in live list
      const idx = liveMemories.findIndex((m) => m.id === decision.id)
      if (idx !== -1) {
        liveMemories[idx] = {
          ...liveMemories[idx]!,
          text: decision.text,
          embedding: JSON.stringify(updatedEmbedding),
        }
      }
      result.factsUpdated++
    } else if (decision.action === 'ADD') {
      const newId = crypto.randomUUID()
      const isDurable = tier === 'durable'
      await db.insert(memories).values({
        id: newId,
        userId: userId || null,
        characterId: characterId || null,
        entityId,
        text: fact.text,
        sourceText: null,
        category: fact.category,
        tier,
        status: 'active',
        embedding: JSON.stringify(factEmbedding),
        importance,
        pinned: isDurable && (fact.category === 'identity' || fact.category === 'relationship'),
        uses: 0,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      liveMemories.push({
        id: newId,
        userId: userId || null,
        characterId: characterId || null,
        entityId,
        text: fact.text,
        sourceText: null,
        category: fact.category,
        tier,
        status: 'active',
        embedding: JSON.stringify(factEmbedding),
        importance,
        pinned: isDurable && (fact.category === 'identity' || fact.category === 'relationship'),
        uses: 0,
        lastUsedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      result.factsAdded++
    }
  }

  return result
}

// ─── Helper: resolve missing entityIds for memories that name known entities ──
// Run after a batch of judge calls to link any facts whose entityName was
// recognised after the entity was created in the same batch.
export async function relinkEntityIds(userId: string, characterId: string | null): Promise<void> {
  const allEntities = await db
    .select()
    .from(entities)
    .where(entityScopeWhere(userId, characterId))

  const nameToId = new Map<string, string>()
  for (const e of allEntities) {
    nameToId.set(e.name.toLowerCase(), e.id)
    try {
      const aliases = JSON.parse(e.aliases) as string[]
      for (const a of aliases) nameToId.set(a.toLowerCase(), e.id)
    } catch { /* ignore */ }
  }

  // Find active memories without entityId that could be linked by text match
  const unlinked = await db
    .select()
    .from(memories)
    .where(
      and(
        userId ? eq(memories.userId, userId) : isNull(memories.userId),
        characterId ? eq(memories.characterId, characterId) : isNull(memories.characterId),
        eq(memories.status, 'active'),
        isNull(memories.entityId),
      ),
    )

  for (const mem of unlinked) {
    const lower = mem.text.toLowerCase()
    for (const [alias, entityId] of nameToId) {
      if (lower.includes(alias)) {
        await db
          .update(memories)
          .set({ entityId, updatedAt: new Date() })
          .where(eq(memories.id, mem.id))
        break
      }
    }
  }
}

// ─── Re-export for tests ──────────────────────────────────────────────────────
export { categoryToTier }
