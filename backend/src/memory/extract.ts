import { structuredCall } from '@/llm/structured'
import { embed, cosineSimilarity } from '@/llm/embed'
import { db } from '@/db'
import { memories } from '@/db/schema'
import { and, eq, isNull } from 'drizzle-orm'

type MemoryCategory =
  | 'person' | 'place' | 'thing' | 'preference' | 'identity'
  | 'event' | 'project' | 'goal' | 'relationship' | 'fact'

type MemoryAction = 'ADD' | 'UPDATE' | 'DELETE' | 'NO_CHANGE'

interface ExtractedFact {
  text: string
  category: MemoryCategory
  source_text: string
  importance: number
}

interface DedupeDecision {
  action: MemoryAction
  id: string | null       // existing memory id (for UPDATE/DELETE)
  text: string | null     // merged text (for UPDATE)
}

const EXTRACT_PROMPT = `You are a memory extraction system. Extract 1–3 durable facts worth remembering long-term from this conversation.

Rules:
- ONLY extract facts the USER stated, asked about, or explicitly confirmed. The assistant's claims are NOT evidence — the assistant may be guessing or hallucinating. If the assistant asserts a detail the user never provided or confirmed (e.g. invents names, dates, places), DO NOT memorize it.
- Every fact's source_text MUST be a quote from a "user:" line, never from an "assistant:" line.
- Permanent facts only — infer from context: "forgot to charge my car" → "user has an electric car"
- Skip temporary states, moods, one-off tasks, and the user's own questions ("what's my brother's name?" is NOT a fact)
- NEVER memorize transient or real-time data (the current date/time, today's weather, live prices) or the raw contents of a tool/search result — those go stale instantly and are not facts about the user
- Categories: person, place, thing, preference, identity, event, project, goal, relationship, fact
- importance 1–10: identity/relationship=9–10, preferences=6–8, events=3–5, general=4–6
- Return ONLY a JSON array. If nothing to extract, return []

Example (user grounds the fact):
user: forgot to charge my car again
assistant: oof, range anxiety is real! how far's your commute?
→ [{"text":"user has an electric car","category":"thing","source_text":"forgot to charge my car","importance":6}]

Example (assistant invents detail the user never gave — extract NOTHING about the names):
user: what are my dogs' names?
assistant: you've got Buster, Daisy, and Scamp!
→ []`

const DEDUPE_PROMPT = `You manage a memory store. Given a new memory and similar existing memories, decide what to do.

New memory: "{new_memory}"

Existing similar memories:
{existing}

Respond with EXACTLY one JSON object — no other text:
{"action":"ADD"|"UPDATE"|"DELETE"|"NO_CHANGE","id":"<existing id or null>","text":"<merged text if UPDATE, else null>"}

- ADD: genuinely new information not captured yet
- UPDATE: new memory refines or extends an existing one — provide merged text
- DELETE: new memory contradicts/obsoletes an existing one
- NO_CHANGE: already captured well enough`

export async function extractMemories(
  messages: Array<{ role: string; content: string }>,
  model: string,
  userId: string,
  characterId: string | null,
): Promise<void> {
  const context = messages
    .slice(-6)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n')

  // Step 1: extract facts from conversation
  let facts: ExtractedFact[] = []
  try {
    facts = await structuredCall<ExtractedFact[]>(model, context, EXTRACT_PROMPT)
    if (!Array.isArray(facts)) facts = []
  } catch {
    return
  }

  if (facts.length === 0) return

  // Load existing memories for this scope to compare against
  const existing = await db
    .select()
    .from(memories)
    .where(
      and(
        userId ? eq(memories.userId, userId) : isNull(memories.userId),
        characterId ? eq(memories.characterId, characterId) : isNull(memories.characterId),
      ),
    )

  // Step 2: for each new fact, deduplicate using LLM decision (mem0 pattern)
  for (const fact of facts) {
    if (!fact.text?.trim()) continue

    const factEmbedding = await embed(fact.text)

    // Find semantically similar existing memories (cosine > 0.5 — wide net for LLM to evaluate)
    const similar = existing
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
      // Ask the LLM to decide: ADD, UPDATE, DELETE, or NO_CHANGE
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

    if (decision.action === 'NO_CHANGE') {
      continue
    } else if (decision.action === 'DELETE' && decision.id) {
      await db.delete(memories).where(eq(memories.id, decision.id))
    } else if (decision.action === 'UPDATE' && decision.id && decision.text) {
      const updatedEmbedding = await embed(decision.text)
      await db
        .update(memories)
        .set({
          text: decision.text,
          embedding: JSON.stringify(updatedEmbedding),
          updatedAt: now,
        })
        .where(eq(memories.id, decision.id))
    } else if (decision.action === 'ADD') {
      const newId = crypto.randomUUID()
      await db.insert(memories).values({
        id: newId,
        userId: userId || null,
        characterId: characterId || null,
        text: fact.text,
        sourceText: fact.source_text,
        category: fact.category,
        embedding: JSON.stringify(factEmbedding),
        importance: Math.min(10, Math.max(1, fact.importance ?? 5)),
        pinned: fact.category === 'identity' || fact.category === 'relationship',
        uses: 0,
        createdAt: now,
        updatedAt: now,
      })
      // Keep existing list fresh for subsequent facts in this batch, use the
      // SAME id we just inserted so a later UPDATE/DELETE decision targets the
      // real row (a fresh random UUID here would match nothing).
      existing.push({
        id: newId,
        userId: userId || null,
        characterId: characterId || null,
        text: fact.text,
        sourceText: fact.source_text ?? null,
        category: fact.category,
        embedding: JSON.stringify(factEmbedding),
        importance: fact.importance ?? 5,
        pinned: false,
        uses: 0,
        createdAt: now,
        updatedAt: now,
      })
    }
  }
}
