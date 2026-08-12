/**
 * Curiosity engine — the companion's active-learning loop.
 *
 * A friend doesn't just answer; they notice what they don't know about your
 * world and ask. This module finds KNOWLEDGE GAPS in the current message,
 * mechanically, against the entity store:
 *
 *   - unnamed relations       "carina's dad", "my coworker"  → who is that?
 *   - unknown names           "with darnell and priya"       → who are they?
 *   - new things              "my new job"                   → tell me about it!
 *   - thin known entities     Artie exists but 1 fact        → learn more
 *
 * The gaps become a one-line prompt nudge (see companionTurn buildSystemParts):
 * after answering, the companion may ask ONE light question about one gap. The
 * user's answer flows through the normal judge pipeline, so curiosity directly
 * compounds the memory store — ask about Carina's dad, learn "Roberto", and
 * Roberto becomes an entity the next sweep.
 *
 * Detection is deliberately conservative: better to miss a gap than to nag.
 */

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { memories } from '@/db/schema'
import { loadScopeEntities, buildAliasIndex, matchPromptEntities } from './recall'

const RELATION_WORDS =
  'dad|father|mom|mother|brother|sister|husband|wife|boyfriend|girlfriend|fianc[eé]e?|son|daughter|' +
  'friend|best friend|boss|coworker|co-worker|colleague|neighbou?r|cousin|uncle|aunt|grandma|grandpa|' +
  'grandmother|grandfather|roommate|buddy|teacher|coach|doctor|therapist'

// "carina's dad" — someone identified only through another person.
const POSSESSIVE_RELATION_RE = new RegExp(`\\b([a-z][\\w-]{2,20})'s\\s+(${RELATION_WORDS})\\b`, 'gi')
// "my coworker darnell" / bare "my coworker" — capture the optional name.
const MY_RELATION_RE = new RegExp(`\\b(?:my|our)\\s+(${RELATION_WORDS})\\b(?:\\s+([a-z][\\w-]{2,15}))?`, 'gi')
// "with carina, bella and bianca" — likely first names being introduced in passing.
const WITH_NAMES_RE = /\b(?:with|and)\s+([a-z][\w-]{2,15})(?:\s*,\s*([a-z][\w-]{2,15}))?(?:\s*,?\s*and\s+([a-z][\w-]{2,15}))?/gi
// "my new job" — a fresh thing in their life worth hearing about.
const NEW_THING_RE = /\b(?:my|our)\s+new\s+([a-z][\w-]{2,20}(?:\s[a-z][\w-]{2,15})?)/gi

// Words the name patterns must never treat as a person.
const NOT_NAMES = new Set([
  'the', 'a', 'an', 'my', 'our', 'his', 'her', 'their', 'your', 'some', 'all', 'both', 'each',
  'friends', 'family', 'everyone', 'everybody', 'people', 'kids', 'guys', 'folks', 'others',
  'him', 'her', 'them', 'you', 'me', 'us', 'it', 'that', 'this', 'these', 'those',
  'work', 'school', 'home', 'lunch', 'dinner', 'breakfast', 'coffee', 'drinks',
  'then', 'now', 'today', 'tomorrow', 'tonight', 'later', 'soon', 'maybe', 'also', 'just',
  'was', 'were', 'is', 'are', 'has', 'had', 'have', 'will', 'would', 'could', 'should',
  'more', 'less', 'most', 'many', 'much', 'very', 'really', 'about', 'after', 'before',
  ...RELATION_WORDS.split('|').filter((w) => !w.includes('[')),
])

const MAX_GAPS = 3
const THIN_ENTITY_FACT_THRESHOLD = 1

/** Human-readable knowledge gaps in this message, most interesting first. */
export async function detectCuriosityGaps(
  prompt: string,
  userId: string,
  characterId: string | null,
): Promise<string[]> {
  if (!prompt || prompt.length < 8) return []
  const rows = await loadScopeEntities(userId, characterId).catch(() => [])
  const aliasIndex = buildAliasIndex(rows)
  const known = (word: string) => aliasIndex.has(word.toLowerCase())

  const gaps: string[] = []
  const seen = new Set<string>()
  const push = (gap: string, dedupeKey: string) => {
    const k = dedupeKey.toLowerCase()
    if (seen.has(k) || gaps.length >= MAX_GAPS) return
    seen.add(k)
    gaps.push(gap)
  }

  // 1. Someone identified only through another person ("carina's dad").
  for (const m of prompt.matchAll(POSSESSIVE_RELATION_RE)) {
    const owner = m[1]!
    const relation = m[2]!
    if (NOT_NAMES.has(owner.toLowerCase())) continue
    if (!known(`${owner}'s ${relation}`)) {
      push(`${owner}'s ${relation} (you don't know their name or anything about them)`, `${owner}'s ${relation}`)
    }
  }

  // 2. "my coworker darnell" (unknown name) or bare "my coworker" (no name at all).
  for (const m of prompt.matchAll(MY_RELATION_RE)) {
    const relation = m[1]!
    const name = m[2]
    if (name && !NOT_NAMES.has(name.toLowerCase()) && !known(name)) {
      push(`their ${relation} ${name[0]!.toUpperCase()}${name.slice(1)} (new to you)`, name)
    } else if (!name && !known(relation)) {
      push(`their ${relation} (you don't know their name)`, `my ${relation}`)
    }
  }

  // 3. Probable first names introduced in passing ("with carina, bella and bianca").
  for (const m of prompt.matchAll(WITH_NAMES_RE)) {
    for (const name of [m[1], m[2], m[3]]) {
      if (!name || NOT_NAMES.has(name.toLowerCase()) || known(name)) continue
      push(`${name[0]!.toUpperCase()}${name.slice(1)} (a name you haven't heard before)`, name)
    }
  }

  // 4. New things in their life ("my new job").
  for (const m of prompt.matchAll(NEW_THING_RE)) {
    const thing = m[1]!.trim()
    if (!known(thing)) push(`their new ${thing}`, `new ${thing}`)
  }

  // 5. Known-but-thin entities: they mentioned someone you technically know but
  //    have almost nothing on — a natural moment to deepen it.
  if (gaps.length < MAX_GAPS) {
    const matched = await matchPromptEntities(prompt, userId, characterId).catch(() => new Set<string>())
    if (matched.size > 0) {
      const ids = [...matched]
      const counts = await db
        .select({ entityId: memories.entityId })
        .from(memories)
        .where(and(inArray(memories.entityId, ids), eq(memories.status, 'active')))
        .catch(() => [] as { entityId: string | null }[])
      const factCount = new Map<string, number>()
      for (const c of counts) { if (c.entityId) factCount.set(c.entityId, (factCount.get(c.entityId) ?? 0) + 1) }
      for (const id of ids) {
        if ((factCount.get(id) ?? 0) <= THIN_ENTITY_FACT_THRESHOLD) {
          const row = rows.find((r) => r.id === id)
          if (row) push(`${row.name} (you know of them, but very little about them)`, `thin:${row.name}`)
        }
      }
    }
  }

  return gaps
}
