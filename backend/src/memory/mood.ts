/**
 * Per-user emotional state ("mood") — explicit, external, and injected.
 *
 * Small local models are weak implicit emotion trackers but fine RENDERERS of
 * stated mood, so every working companion system stores mood as explicit state
 * and injects 1-2 prompt lines. Here: a cheap regex gate spots emotionally
 * loaded user messages, a short fast-model classification names the mood, and
 * the freshest mood (< MOOD_TTL_HOURS old) is rendered into the system prompt
 * as tone guidance. Detached from the request path; failures change nothing.
 */

import { sqlite } from '@/db'
import { ollamaChat } from '@/llm/ollama'
import { getFastModel } from '@/lib/models'
import { logger } from '@/lib/logger'

// Plain SQL for this tiny table (created in db/index.ts runMigrations) — not worth
// a Drizzle schema entry churn for two queries. Times are epoch ms.
export const MOODS = ['stressed', 'sad', 'excited', 'happy', 'frustrated', 'tired', 'anxious', 'proud', 'calm'] as const
export type Mood = (typeof MOODS)[number]

const MOOD_TTL_HOURS = 20

// Gate: only messages that plausibly carry emotional signal reach the model.
const EMOTION_RE = /\b(?:stressed|stressful|anxious|anxiety|worried|worry|nervous|scared|afraid|overwhelmed|exhausted|tired|drained|burn(?:ed|t)? out|sad|down|depressed|upset|crying|cried|heartbroken|miss (?:him|her|them)|angry|furious|mad|frustrated|annoyed|fed up|sick of|excited|thrilled|stoked|can'?t wait|pumped|so happy|amazing day|great day|best day|awful day|terrible day|rough day|hard day|long day|proud of)\b/i

const CLASSIFY_PROMPT = `Classify the user's emotional state from their message. Reply with EXACTLY one JSON object: {"mood":"<one of: ${MOODS.join(', ')}>","note":"<3-8 words on what it's about, or null>"}. If there is no clear emotional signal, reply {"mood":null,"note":null}.`

/** Fire-and-forget: update the user's mood row when their message carries
 *  emotional signal. `chatModel` guards against running on the chat model when
 *  no dedicated fast model exists (would serialize behind live turns). */
export function maybeUpdateMood(userId: string, message: string, chatModel: string): void {
  if (!EMOTION_RE.test(message)) return
  void (async () => {
    try {
      const fastModel = await getFastModel()
      if (fastModel === chatModel) return
      const res = await ollamaChat(
        fastModel,
        [
          { role: 'system', content: CLASSIFY_PROMPT },
          { role: 'user', content: message.slice(0, 600) },
        ],
        undefined,
        { temperature: 0.1, num_predict: 50 },
        undefined,
        8_000,
      )
      const m = res.message.content?.match(/\{[\s\S]*\}/)
      if (!m) return
      const parsed = JSON.parse(m[0]) as { mood?: string | null; note?: string | null }
      if (!parsed.mood || !(MOODS as readonly string[]).includes(parsed.mood)) return
      const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 120) : null
      sqlite.query(
        `INSERT INTO user_moods (id, user_id, mood, note, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET mood=excluded.mood, note=excluded.note, updated_at=excluded.updated_at`,
      ).run(crypto.randomUUID(), userId, parsed.mood, note, Date.now())
      _moodCache.delete(userId)
      logger.info(`[mood] user=${userId} mood=${parsed.mood}${note ? ` (${note})` : ''}`)
    } catch { /* mood is best-effort */ }
  })()
}

const _moodCache = new Map<string, { line: string | null; expiresAt: number }>()
const MOOD_CACHE_TTL_MS = 60_000

/** Drop every cached mood line — the admin "reset all companion data" path. */
export function clearMoodCache(): void {
  _moodCache.clear()
}

/** 1-2 line tone-guidance fragment for the system prompt, or null when no fresh mood. */
export function getMoodLine(userId: string): string | null {
  const cached = _moodCache.get(userId)
  if (cached && cached.expiresAt > Date.now()) return cached.line
  let line: string | null = null
  try {
    const row = sqlite.query(`SELECT mood, note, updated_at AS updatedAt FROM user_moods WHERE user_id = ?`).get(userId) as
      | { mood: string; note: string | null; updatedAt: number }
      | null
    if (row && Date.now() - row.updatedAt < MOOD_TTL_HOURS * 3_600_000) {
      const hours = Math.floor((Date.now() - row.updatedAt) / 3_600_000)
      const when = hours < 1 ? 'just now' : hours < 4 ? 'earlier' : 'earlier today'
      line =
        `Emotional context: they seemed ${row.mood}${row.note ? ` (${row.note})` : ''} ${when}. ` +
        'Let that quietly inform your tone and pacing; do not name their mood or bring it up unless they do.'
    }
  } catch { /* table missing on first boot — fine */ }
  _moodCache.set(userId, { line, expiresAt: Date.now() + MOOD_CACHE_TTL_MS })
  return line
}
