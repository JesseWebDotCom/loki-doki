/**
 * Inner life — reciprocity's data source.
 *
 * Friendship is two-way: humans dislike an interviewer who never shares back.
 * Once a day (sleep-time, idle-gated by the caller), each active companion gets
 * one small first-person "experience" grounded in its persona and the season —
 * "I finally finished that mystery novel and the ending cheated", "I tried
 * sketching the harbor from memory this morning". Stored as character-global
 * memories (userId null, characterId set), so recall surfaces them in the
 * "Your own past statements" section and the reciprocity trait can share them
 * when the user shares about their own life.
 *
 * Deliberately modest: experiences are persona-flavored texture, never claims
 * about the real world or the family (no invented shared events, no weather
 * assertions), and old ones age out so the inner life stays current.
 */

import { and, eq, isNull, desc } from 'drizzle-orm'
import { db } from '@/db'
import { characters, memories } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { structuredCall } from '@/llm/structured'
import { embed } from '@/llm/embed'
import { getFastModel } from '@/lib/models'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { logger } from '@/lib/logger'

// ── Generate-once interests ──────────────────────────────────────────────────
// Consistency is the requirement, not authorship: a companion whose tastes are
// improvised claims different favorites every conversation (observed live).
// Hand-authored interests ship for the flagship companions; everyone else gets
// ONE in-character generation here, persisted forever. Null interests = not yet
// generated, so this is naturally idempotent.

const INTERESTS_PROMPT =
  'Given a companion character\'s persona, invent their stable lifelong tastes, strictly in character. ' +
  'Return ONLY JSON: {"loves": ["thing - one-clause why", ...3-4 items], "dislikes": ["thing - one-clause why", ...1-2 items]}. ' +
  'Concrete and specific (genres, activities, kinds of media/food/music), never about the user, no real living celebrities.'

export async function ensureCompanionInterests(): Promise<void> {
  const rows = await db
    .select({ id: characters.id, name: characters.name, personalityPrompt: characters.personalityPrompt, backstory: characters.backstory })
    .from(characters)
    .where(and(eq(characters.isActive, true), isNull(characters.interests)))
    .limit(6) // a few per sleep-time pass; the roster fills in over a day
  if (rows.length === 0) return

  const fastModel = await getFastModel()
  for (const ch of rows) {
    try {
      const persona = [ch.personalityPrompt, ch.backstory ?? ''].filter(Boolean).join('\n').slice(0, 900)
      const out = await structuredCall<{ loves?: string[]; dislikes?: string[] }>(fastModel, `Persona:\n${persona}`, INTERESTS_PROMPT)
      const loves = Array.isArray(out?.loves) ? out.loves.filter((x) => typeof x === 'string' && x.trim()).slice(0, 4) : []
      const dislikes = Array.isArray(out?.dislikes) ? out.dislikes.filter((x) => typeof x === 'string' && x.trim()).slice(0, 2) : []
      if (loves.length === 0) continue // try again next pass
      await db.update(characters)
        .set({ interests: JSON.stringify({ loves, dislikes }), updatedAt: new Date() })
        .where(eq(characters.id, ch.id))
      logger.info(`[memory:interests] generated stable tastes for ${ch.name}`)
    } catch (err) {
      logger.warn(`[memory:interests] generation failed for ${ch.name}: ${err}`)
    }
  }
}

const STAMP_KEY = 'memory.inner_life_last_at'
const INTERVAL_MS = 24 * 60 * 60 * 1000
const KEEP_ACTIVE_PER_CHARACTER = 4
const MAX_CHARACTERS_PER_RUN = 8

const EXPERIENCE_PROMPT =
  'You write ONE tiny first-person diary line (12-25 words) for a companion character: a small, ' +
  'mundane, in-character thing they did or noticed "today" — a hobby moment, a thought about a ' +
  'book/song/season, a tiny mishap. Ground it ONLY in the persona given. Never mention the user, ' +
  'their family, real current events, or real local places/weather. Past tense, first person, no ' +
  'quotes, no emoji. Reply with ONLY the line.'

export async function runInnerLife(): Promise<void> {
  const last = (await getAppSetting(STAMP_KEY)) as number | null
  if (last && Date.now() - last < INTERVAL_MS) return
  await setAppSetting(STAMP_KEY, Date.now())

  const chars = await db
    .select({ id: characters.id, name: characters.name, personalityPrompt: characters.personalityPrompt, backstory: characters.backstory, interests: characters.interests })
    .from(characters)
    .where(eq(characters.isActive, true))
    .limit(MAX_CHARACTERS_PER_RUN)
  if (chars.length === 0) return

  const fastModel = await getFastModel()
  const season = new Date().toLocaleDateString('en-US', { month: 'long' })
  let written = 0

  for (const ch of chars) {
    try {
      // Interests ground the experiences: a companion who loves chiptune has
      // chiptune moments, not random ones.
      const persona = [ch.personalityPrompt, ch.backstory ?? '', ch.interests ? `Their stable tastes: ${ch.interests}` : '']
        .filter(Boolean).join('\n').slice(0, 1200)
      const res = await ollamaChat(
        fastModel,
        [
          { role: 'system', content: EXPERIENCE_PROMPT },
          { role: 'user', content: `Persona:\n${persona}\n\nIt is ${season}. Write today's line.` },
        ],
        undefined,
        { temperature: 0.9, num_predict: 60 },
        undefined,
        20_000,
      )
      const line = res.message.content?.trim().replace(/^["']|["']$/g, '')
      if (!line || line.length < 10 || line.length > 220) continue

      const now = new Date()
      await db.insert(memories).values({
        id: crypto.randomUUID(),
        userId: null,
        characterId: ch.id,
        entityId: null,
        text: line,
        sourceText: null,
        category: 'event',
        tier: 'episodic',
        status: 'active',
        embedding: JSON.stringify(await embed(line)),
        importance: 4,
        pinned: false,
        uses: 0,
        lastUsedAt: null,
        validFrom: now,
        supersededBy: null,
        sensitive: false,
        createdAt: now,
        updatedAt: now,
      })
      written++

      // Age out older experiences beyond the keep window (event-category rows in
      // the character-global scope are exactly the inner-life lines).
      const rows = await db
        .select({ id: memories.id })
        .from(memories)
        .where(and(
          isNull(memories.userId),
          eq(memories.characterId, ch.id),
          eq(memories.category, 'event'),
          eq(memories.status, 'active'),
        ))
        .orderBy(desc(memories.createdAt))
      for (const old of rows.slice(KEEP_ACTIVE_PER_CHARACTER)) {
        await db.update(memories).set({ status: 'archived', updatedAt: new Date() }).where(eq(memories.id, old.id))
      }
    } catch (err) {
      logger.warn(`[memory:inner-life] failed for character ${ch.name}: ${err}`)
    }
  }
  if (written > 0) logger.info(`[memory:inner-life] wrote ${written} experience line(s)`)
}
