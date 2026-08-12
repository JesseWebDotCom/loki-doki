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
import { embed, cosineSimilarity, cachedVector } from '@/llm/embed'
import { db } from '@/db'
import { memories, entities } from '@/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { captureNoteFact } from '@/lib/notes/capture'
import { logger } from '@/lib/logger'

// ─── Types ────────────────────────────────────────────────────────────────────

type MemoryCategory =
  | 'person' | 'place' | 'thing' | 'preference' | 'identity'
  | 'event' | 'project' | 'goal' | 'relationship' | 'fact' | 'state'

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
  sourceQuote?: string | null // verbatim user phrase the fact came from (provenance)
  scope?: 'user' | 'household' // household = shared with everyone in the home
  // procedural = how-to/reference knowledge about the user's own things; routed to
  // the Notes app instead of the memories table. OPTIONAL by design: a model that
  // omits it degrades to 'personal', which is exactly the pre-notes behavior.
  kind?: 'personal' | 'procedural'
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
  /** Procedural facts routed to the Notes app (appended or created; dupes excluded). */
  notesCaptured: number
  /** True when Phase-1 extraction failed — the span was NOT processed and the
   *  caller must not advance its cursor past these messages. */
  failed: boolean
  /** True when any HOUSEHOLD-scope row was added/updated/superseded — callers
   *  must invalidate EVERY user's cached memory block, not just this user's. */
  householdTouched: boolean
}

// ─── Phase 1 prompt: extract from conversation ────────────────────────────────

const EXTRACT_PROMPT = `You are a long-term memory manager for a personal AI. Review the conversation below and extract:
1. Named entities personally relevant to the user (people, places, things they own/care about).
2. Durable facts worth remembering long-term.

SOURCE RULE — extract ONLY facts the User asserted or explicitly confirmed. Assistant statements are context, never a source: if the assistant guessed something about the user ("since you're a teacher…") and the user didn't confirm it, do NOT store it.

TIME RULE — the conversation date is given at the top. Resolve relative time into absolute terms in the fact text: "I'm getting married next month" on 2026-07-01 → "user is getting married in August 2026". Never store a bare "next week"/"yesterday" — those rot.

SPECIFICITY RULE — keep names and who/what EXACTLY as stated. Never blur a named person into "someone": "my daughter Lily is allergic to peanuts" → entity Lily (person, aliases ["lily","daughter"]) + fact "daughter Lily is allergic to peanuts" with entityName "Lily" — NOT "user is a parent of someone with a peanut allergy". A fact that loses its subject's name is worth less than the sentence it came from.

CRITICAL — DISCARD these, do NOT extract:
- Questions the user asked or information they looked up (one-off curiosity)
- One-moment moods and feelings ("I'm tired", "I'm excited today", "I'm hungry")
- Tasks, to-dos, or things to do later
- Facts about the world that don't reveal anything about the user (but procedural knowledge about the user's OWN things is worth keeping — see KIND below)
- Anything the user asked about as a passing question with no personal relevance
- Meta-statements about the user's relationship to real-time/transient data — "the user knows the current date", "the user is unsure about the date", "the user asked about the weather". The current date/time/weather/prices are not facts about the user, and neither is whether they currently know them.
- Trivially-true or contentless observations ("the user said hi", "the user is chatting", "the user wants help")

SCOPE — each fact carries a "scope":
- "user" (default): a fact about THIS person specifically.
- "household": a shared fact about the home everyone in the family should know — the wifi network name, the dog's name, where the spare key lives, the trash pickup day, the address. If a new family member would need to be told it, it's household.

KIND — each fact carries a "kind":
- "personal" (default): a fact ABOUT the user or their people (preferences, identity, relationships, events, states).
- "procedural": how-to, reference, or technical knowledge about the user's OWN things, stated by the user — device procedures ("hold the reset button 10 seconds"), configs, measurements, materials used, install gotchas. These are filed as notes, not personal memories. Only what the USER asserted from their own experience — never the assistant's own instructions or answers.

PERSIST these:
- Stable facts about the user's identity, life, relationships, preferences
- People, places, or things personally important to them
- Long-running projects, goals, or aspirations
- Corrections or updates to previously stated facts
- Procedural/reference knowledge the user stated about their own things (kind: "procedural")
- Ongoing multi-day situations ("stressed about a work deadline", "recovering from knee surgery", "training for a marathon") → category "state" — these power caring follow-ups ("feeling better?") and auto-expire after about a week, so persist the situation, not the moment

Category options: person, place, thing, preference, identity, event, project, goal, relationship, fact, state
Tier:
- "durable" = identity, relationship, person, preference — these facts should live forever
- "episodic" = event, project, goal, thing, place, fact, state — subject to decay over time
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
- "my daughter Lily is allergic to peanuts" → PERSIST entity:Lily(person,aliases:["lily","daughter"]), fact:"daughter Lily is allergic to peanuts" (entityName:"Lily", category:relationship, tier:durable, importance:9 — health facts about family are high-stakes and must keep the name)
- "turns out you have to hold the reset button on my arcade cabinet for 10 seconds" → PERSIST fact:"the arcade cabinet resets by holding the reset button 10 seconds" (kind:procedural)
- Assistant: "You can reset it by holding the power button" (user never confirmed) → DISCARD (assistant statement, not user knowledge)

Each fact carries a "sourceQuote": the short verbatim phrase FROM THE USER that the fact came from (provenance — lets a human audit why the memory exists).

Return ONLY a JSON object in this exact shape (empty arrays if nothing to extract):
{
  "entities": [
    { "name": "Artie", "kind": "person", "aliases": ["artie", "brother", "art"], "importance": 8 }
  ],
  "facts": [
    { "text": "user has an electric car", "category": "thing", "tier": "episodic", "importance": 5, "entityName": null, "sourceQuote": "I forgot to charge my car", "scope": "user", "kind": "personal" },
    { "text": "Artie loves horror movies", "category": "preference", "tier": "durable", "importance": 7, "entityName": "Artie", "sourceQuote": "My brother Artie loves horror movies", "scope": "user", "kind": "personal" },
    { "text": "the family dog is named Biscuit", "category": "fact", "tier": "durable", "importance": 7, "entityName": null, "sourceQuote": "Biscuit chewed the couch again", "scope": "household", "kind": "personal" },
    { "text": "the arcade cabinet resets by holding the reset button 10 seconds", "category": "fact", "tier": "episodic", "importance": 5, "entityName": "arcade cabinet", "sourceQuote": "you have to hold the reset button for 10 seconds", "scope": "user", "kind": "procedural" }
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
- DELETE: new memory REPLACES or invalidates an existing one (the fact changed — "I moved", "I sold the car", "I don't like it anymore"). The old memory is removed AND the new one is stored.
- NO_CHANGE: already captured well enough

Prefer UPDATE when the two can be merged into one accurate statement; use DELETE when the old statement is now simply false.`

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

// Generic relationship/possession words that appear in MANY entities' alias lists
// ("brother", "mom", "boss"). A match through one of these alone must never merge
// two different people — "my brother Dave" used to merge into Artie's entity via
// the shared "brother" alias, attributing Dave's facts to Artie.
const GENERIC_ALIAS_RE = /^(?:brother|sister|mom|mother|dad|father|parents?|wife|husband|partner|spouse|boyfriend|girlfriend|fianc[eé]e?|boss|manager|friend|best friend|buddy|son|daughter|kids?|child|children|grandma|grandpa|grandmother|grandfather|aunt|uncle|cousin|niece|nephew|neighbou?r|coworker|co-worker|colleague|roommate|doctor|dentist|teacher|therapist|dog|cat|pet|work|job|school|office|home|house|car|truck)$/i

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
    notesCaptured: 0,
    failed: false,
    householdTouched: false,
  }

  if (messages.length === 0) return result

  // Build conversation text for the judge (exclude system messages). The date
  // header powers the TIME RULE — relative time resolves to absolute in fact text.
  const convDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const conversationText = `(Conversation date: ${convDate})\n` + messages
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
    // Extraction failed (twice, incl. structuredCall's retry). Flag it so the sweep
    // does NOT advance memoryProcessedThrough — otherwise these messages would be
    // permanently skipped and their facts silently lost.
    result.failed = true
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
    // structuredCall's JSON.parse has no schema validation, so a malformed/truncated LLM
    // entity (missing name, or a non-array aliases) would otherwise crash the
    // e.name.toLowerCase() below instead of just being skipped like an empty fact is.
    if (!e?.name?.trim()) continue
    if (!Array.isArray(e.aliases)) e.aliases = []
    const canonicalKey = e.name.toLowerCase()
    // Merge on a direct name match, or on a NON-generic alias match. A generic
    // relationship word ("brother") shared between two differently-named people
    // creates a NEW entity instead of merging (see GENERIC_ALIAS_RE).
    const existingId = entityIdByName.get(canonicalKey)
      ?? e.aliases
          .filter((a) => !GENERIC_ALIAS_RE.test(a.trim()))
          .map((a) => entityIdByName.get(a.toLowerCase()))
          .find(Boolean)

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

  // Household facts live in the (userId=null, characterId=null) scope — shared by
  // EVERYONE in the home ("the dog's name is Biscuit" shouldn't be re-learned per
  // family member). Loaded lazily, only when the extractor tagged any.
  const hasHousehold = extracted.facts.some((f) => f.scope === 'household')
  const householdLive = hasHousehold
    ? [...await db
        .select()
        .from(memories)
        .where(and(isNull(memories.userId), isNull(memories.characterId), eq(memories.status, 'active')))]
    : []

  for (const fact of extracted.facts) {
    if (!fact.text?.trim()) continue

    // Household facts read/write the shared home scope; entity links stay
    // user-scoped, so household rows carry none.
    const isHousehold = fact.scope === 'household'
    const live = isHousehold ? householdLive : liveMemories

    const factEmbedding = await embed(fact.text)

    // Procedural facts route to the Notes app through the same capture pipeline as
    // the explicit remember tool (append-vs-create, dedupe, device linking), never
    // to the memories table. The judge is a passive capture with no explicit user
    // intent, so it never appends to household-shared notes (allowSharedAppend:
    // false) and a capture failure falls through to the memory path below, keeping
    // today's behavior as the worst case.
    if (fact.kind === 'procedural' && userId) {
      try {
        const captured = await captureNoteFact({
          userId,
          allowSharedAppend: false,
          fact: fact.text,
          factEmbedding,
          title: fact.entityName ?? undefined,
        })
        if (captured.status !== 'duplicate') result.notesCaptured++
        continue
      } catch (err) {
        logger.warn(`[memory:judge] procedural note capture failed, storing as memory: ${err}`)
      }
    }

    // Find semantically similar existing memories (wide net — LLM makes the final
    // call). Sorted by similarity so the 5 CLOSEST are shown — the old unsorted
    // slice could show 5 above-threshold rows while the true duplicate sat 6th.
    const similar = live
      .map((m) => {
        if (!m.embedding) return null
        const vec = cachedVector(`${m.id}:${m.updatedAt?.getTime() ?? 0}`, m.embedding)
        if (!vec) return null
        return { m, cos: cosineSimilarity(factEmbedding, vec) }
      })
      .filter((x): x is { m: (typeof liveMemories)[number]; cos: number } => x !== null && x.cos > 0.5)
      .sort((a, b) => b.cos - a.cos)
      .slice(0, 5)
      .map((x) => x.m)

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
    } else if (decision.action === 'UPDATE' && decision.id && decision.text) {
      // Preserve maxima from the existing row: a low-importance episodic refinement
      // must never demote a durable memory to episodic (exposing it to decay) or
      // lower its importance, and an existing entity link survives a fact whose
      // entityName the extractor didn't repeat.
      const existingRow = live.find((m) => m.id === decision.id)
      const keptTier = existingRow?.tier === 'durable' ? 'durable' : tier
      const keptImportance = Math.max(importance, existingRow?.importance ?? 0)
      const keptEntityId = entityId ?? existingRow?.entityId ?? null
      const updatedEmbedding = await embed(decision.text)
      await db
        .update(memories)
        .set({
          text: decision.text,
          embedding: JSON.stringify(updatedEmbedding),
          tier: keptTier,
          importance: keptImportance,
          entityId: keptEntityId,
          updatedAt: now,
        })
        .where(eq(memories.id, decision.id))
      // Refresh in live list
      const idx = live.findIndex((m) => m.id === decision.id)
      if (idx !== -1) {
        live[idx] = {
          ...live[idx]!,
          text: decision.text,
          embedding: JSON.stringify(updatedEmbedding),
        }
      }
      result.factsUpdated++
      if (isHousehold) result.householdTouched = true
    } else {
      // ADD — or DELETE, which supersedes the old row and then STORES the new fact.
      // (DELETE used to drop the new fact on the floor: "I moved to Boston" would
      // supersede "lives in NYC" and store nothing. Replacement facts must survive.)
      const newId = crypto.randomUUID()
      if (decision.action === 'DELETE' && decision.id) {
        // Soft-delete: mark superseded rather than hard-deleting (Zep bi-temporal
        // pattern), and LINK the old row to its replacement so recall can render
        // "previously: lived in NYC" next to the current fact.
        await db
          .update(memories)
          .set({ status: 'superseded', supersededBy: newId, updatedAt: now })
          .where(eq(memories.id, decision.id))
        // Remove from live list so subsequent facts in this batch don't match it
        const idx = live.findIndex((m) => m.id === decision.id)
        if (idx !== -1) live.splice(idx, 1)
        result.factsSuperseded++
        if (isHousehold) result.householdTouched = true
      }
      const isDurable = tier === 'durable'
      const sourceText = typeof fact.sourceQuote === 'string' && fact.sourceQuote.trim()
        ? fact.sourceQuote.trim().slice(0, 500)
        : null
      await db.insert(memories).values({
        id: newId,
        userId: isHousehold ? null : (userId || null),
        characterId: isHousehold ? null : (characterId || null),
        entityId: isHousehold ? null : entityId,
        text: fact.text,
        sourceText,
        category: fact.category,
        tier,
        status: 'active',
        embedding: JSON.stringify(factEmbedding),
        importance,
        pinned: isDurable && (fact.category === 'identity' || fact.category === 'relationship'),
        uses: 0,
        lastUsedAt: null,
        validFrom: now,
        supersededBy: null,
        createdAt: now,
        updatedAt: now,
      })
      live.push({
        id: newId,
        userId: isHousehold ? null : (userId || null),
        characterId: isHousehold ? null : (characterId || null),
        entityId: isHousehold ? null : entityId,
        text: fact.text,
        sourceText,
        category: fact.category,
        tier,
        status: 'active',
        embedding: JSON.stringify(factEmbedding),
        importance,
        pinned: isDurable && (fact.category === 'identity' || fact.category === 'relationship'),
        uses: 0,
        lastUsedAt: null,
        validFrom: now,
        supersededBy: null,
        createdAt: now,
        updatedAt: now,
      })
      result.factsAdded++
      if (isHousehold) result.householdTouched = true
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
    for (const [alias, entityId] of nameToId) {
      // Whole-word matches only (substring matching linked alias "art" to any
      // memory containing "artichoke"), skip 1–2 char aliases, and never link
      // through a generic relationship word — those belong to many entities.
      if (alias.length < 3 || GENERIC_ALIAS_RE.test(alias)) continue
      const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      if (re.test(mem.text)) {
        await db
          .update(memories)
          .set({ entityId, updatedAt: new Date() })
          .where(eq(memories.id, mem.id))
        break
      }
    }
  }
}

// ─── Companion self-memory ────────────────────────────────────────────────────
// Humans remember what THEY said, not just facts about the other person. This
// pass extracts the COMPANION's own notable statements from a judged span:
//   opinions/stances → character-global scope (userId=null, characterId=Y):
//     the character's own worldview, consistent across every user.
//   promises/personal statements to this user → character-instance scope
//     (userId=X, characterId=Y): relationship-private.
// Recall already reads both scopes (memoryScopeWhere); formatting gives them a
// dedicated "Your own past statements" section so the companion stays consistent
// with itself instead of contradicting yesterday's stance.
// Deliberately a SEPARATE small call, not a rider on EXTRACT_PROMPT — that prompt
// is load-bearing for user-fact quality on a small model.

const SELF_EXTRACT_PROMPT = `You review a conversation from the ASSISTANT's side. Extract only the assistant's own memorable commitments and stances — things IT said that IT should remember having said:

1. "opinion": a clear stance, taste, or preference the assistant expressed as its own ("I love rainy days", "horror movies aren't my thing").
2. "promise": a commitment the assistant made to the user ("I'll remind you Friday", "next time we'll plan the trip").
3. "statement": a notable personal claim the assistant made about itself ("my favorite color is green").

DISCARD: factual answers, tool results, summaries of what the user said, generic encouragement, anything the assistant said only once in passing with no commitment or stance.

Write each fact in first person past framing from the assistant's perspective, e.g. "I told them I'd remind them about the dentist on Friday", "I said horror movies aren't my thing".

Return ONLY JSON: {"facts":[{"text":"...","kind":"opinion"|"promise"|"statement","importance":1-10}]} (empty array if nothing qualifies).`

interface SelfFact {
  text: string
  kind: 'opinion' | 'promise' | 'statement'
  importance: number
}

// Near-duplicate gate for self-facts — no LLM dedup round (kept cheap); a high
// cosine against an existing row in the same scope means we already have it.
const SELF_DUP_COSINE = 0.85
const SELF_FACTS_MAX = 4

export async function runSelfJudge(
  userId: string,
  characterId: string,
  messages: Array<{ role: string; content: string }>,
  model: string,
): Promise<number> {
  const assistantSaidAnything = messages.some((m) => m.role === 'assistant' && m.content.trim().length > 0)
  if (!assistantSaidAnything) return 0

  const conversationText = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')

  let facts: SelfFact[]
  try {
    const out = await structuredCall<{ facts: SelfFact[] }>(model, conversationText, SELF_EXTRACT_PROMPT)
    facts = Array.isArray(out?.facts) ? out.facts.slice(0, SELF_FACTS_MAX) : []
  } catch {
    return 0 // best-effort — self-memory never blocks the sweep
  }

  let written = 0
  for (const fact of facts) {
    if (!fact?.text?.trim()) continue
    const kind = fact.kind === 'opinion' || fact.kind === 'promise' || fact.kind === 'statement' ? fact.kind : 'statement'
    // Opinions are the character's own worldview (shared across users);
    // promises/statements were made to THIS user (relationship-private).
    const scopeUserId = kind === 'opinion' ? null : userId
    const rowScope = and(
      scopeUserId ? eq(memories.userId, scopeUserId) : isNull(memories.userId),
      eq(memories.characterId, characterId),
      eq(memories.status, 'active'),
    )

    const embedding = await embed(fact.text)
    const existing = await db.select().from(memories).where(rowScope)
    const dup = existing.some((m) => {
      if (!m.embedding) return false
      const vec = cachedVector(`${m.id}:${m.updatedAt?.getTime() ?? 0}`, m.embedding)
      return !!vec && cosineSimilarity(embedding, vec) >= SELF_DUP_COSINE
    })
    if (dup) continue

    const now = new Date()
    await db.insert(memories).values({
      id: crypto.randomUUID(),
      userId: scopeUserId,
      characterId,
      entityId: null,
      text: fact.text.trim().slice(0, 500),
      sourceText: null,
      // opinions read like preferences and should persist; promises/statements
      // are episodic (a promise about Friday should decay once Friday is long past).
      category: kind === 'opinion' ? 'preference' : kind === 'promise' ? 'goal' : 'fact',
      tier: kind === 'opinion' ? 'durable' : 'episodic',
      status: 'active',
      embedding: JSON.stringify(embedding),
      importance: Math.min(10, Math.max(1, fact.importance ?? 5)),
      pinned: false,
      uses: 0,
      lastUsedAt: null,
      validFrom: now,
      supersededBy: null,
      createdAt: now,
      updatedAt: now,
    })
    written++
  }
  return written
}

// ─── Re-export for tests ──────────────────────────────────────────────────────
export { categoryToTier }
