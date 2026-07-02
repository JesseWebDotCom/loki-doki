// Companion-initiated check-ins — the one place the companion speaks FIRST.
//
// Product shape (deliberately narrow):
//   - Triggered ONLY by open threads: recent state/goal/event memories the user
//     themselves shared ("interview tomorrow", "training for a marathon"). The
//     companion never cold-opens about nothing.
//   - At most ONE check-in per user per day, daytime only (server-local clock —
//     on a home server that's the family's timezone).
//   - Each thread is used at most once, ever.
//   - Delivered through the existing notification system (bell + optional push),
//     NOT by hijacking the overlay — the user reads it on their own terms and
//     can reply by opening chat.
//   - Opt-out via the normal notification mute (Settings → Notifications →
//     "Companion check-ins"), checked SERVER-side before anything is generated.

import { and, eq, isNull, gte, inArray, desc } from 'drizzle-orm'
import { db } from '@/db'
import { memories, users, userPreferences, characters } from '@/db/schema'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { emitNotification } from '@/lib/notify'
import { logger } from '@/lib/logger'

const TICK_MS = 60 * 60 * 1000            // consider check-ins hourly
const FIRST_TICK_DELAY_MS = 5 * 60 * 1000 // let boot warmup finish first
const MIN_INTERVAL_MS = 22 * 60 * 60 * 1000 // ≥22h between check-ins per user
const WINDOW_START_HOUR = 9               // no check-ins before 9am…
const WINDOW_END_HOUR = 21                // …or after 9pm
const THREAD_WINDOW_DAYS = 7
const STATE_PREF_KEY = 'companion.checkin_state'
const ACTIVE_PREF_KEY = 'companion.active_character_id'
const MUTED_PREF_KEY = 'notifications.muted'

interface CheckinState {
  lastAt: number
  usedMemoryIds: string[]
}

let ticking = false

export function startCompanionCheckins(): { stop: () => void } {
  const interval = setInterval(() => { void tick() }, TICK_MS)
  const kickoff = setTimeout(() => { void tick() }, FIRST_TICK_DELAY_MS)
  logger.info('[companion:checkin] scheduler started (hourly, 1/day/user max)')
  return {
    stop() {
      clearInterval(interval)
      clearTimeout(kickoff)
    },
  }
}

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const hour = new Date().getHours()
    if (hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR) return

    const allUsers = await db.select({ id: users.id, nickname: users.nickname, firstName: users.firstName }).from(users)
    for (const user of allUsers) {
      try {
        await maybeCheckIn(user)
      } catch (err) {
        logger.warn(`[companion:checkin] failed for user=${user.id}: ${err}`)
      }
    }
  } finally {
    ticking = false
  }
}

async function readPref<T>(userId: string, key: string): Promise<T | null> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)))
    .limit(1)
  if (!row) return null
  try { return JSON.parse(row.value) as T } catch { return null }
}

async function maybeCheckIn(user: { id: string; nickname: string | null; firstName: string | null }): Promise<void> {
  // Opt-out: the "Companion check-ins" category in Settings → Notifications.
  // Checked server-side so muted users never even cost a generation.
  const muted = await readPref<string[]>(user.id, MUTED_PREF_KEY)
  if (Array.isArray(muted) && muted.includes('companion_checkin')) return

  const state = (await readPref<CheckinState>(user.id, STATE_PREF_KEY)) ?? { lastAt: 0, usedMemoryIds: [] }
  if (Date.now() - state.lastAt < MIN_INTERVAL_MS) return

  // A fresh open thread the user shared recently and we haven't asked about yet.
  const cutoff = new Date(Date.now() - THREAD_WINDOW_DAYS * 86_400_000)
  const threads = await db
    .select({ id: memories.id, text: memories.text, category: memories.category })
    .from(memories)
    .where(
      and(
        eq(memories.userId, user.id),
        isNull(memories.characterId),
        eq(memories.status, 'active'),
        inArray(memories.category, ['state', 'goal', 'event']),
        gte(memories.createdAt, cutoff),
      ),
    )
    .orderBy(desc(memories.importance), desc(memories.createdAt))
    .limit(10)
  const thread = threads.find((t) => !state.usedMemoryIds.includes(t.id))
  if (!thread) return

  // Speak as the user's active companion (fall back to a generic voice).
  const activeCharId = await readPref<string | null>(user.id, ACTIVE_PREF_KEY)
  const charRow = activeCharId
    ? await db.select().from(characters).where(eq(characters.id, activeCharId)).limit(1).then((r) => r[0] ?? null)
    : null
  const characterName = charRow?.name ?? 'Your companion'
  const displayName = user.nickname?.trim() || user.firstName?.trim() || null
  // First paragraph = core identity; the full persona is overkill for two sentences.
  const personaCore = charRow?.personalityPrompt.split('\n\n')[0]?.trim()
    ?? 'You are a warm, friendly companion.'

  const model = await getModel() // the 3B fast model degenerates on emotional prompts
  const res = await ollamaChat(
    model,
    [
      {
        role: 'system',
        content: `${personaCore}\n\nWrite ONE short, warm check-in message (1–2 spoken-tone sentences) to ${displayName ?? 'the user'}, prompted by something they shared recently. Ask about it naturally — like a friend who remembered. No greeting formulas, no sign-off, no emojis, no quotation marks. Reply with ONLY the message.`,
      },
      { role: 'user', content: `What you remembered they shared: ${thread.text}` },
    ],
    undefined,
    { temperature: 0.7, num_predict: 80 },
    undefined,
    30_000,
  )
  const message = res.message.content?.trim().replace(/^["']|["']$/g, '')
  // A bad generation just skips this tick — never deliver junk proactively.
  if (!message || message.length < 8 || message.length > 300) return

  const now = new Date()
  await emitNotification({
    type: 'companion_checkin',
    userId: user.id,
    title: characterName,
    body: message,
    url: '/chat',
    payload: {
      message,
      characterId: charRow?.id ?? null,
      characterName,
      memoryId: thread.id,
    },
  })

  await db
    .insert(userPreferences)
    .values({
      id: crypto.randomUUID(),
      userId: user.id,
      key: STATE_PREF_KEY,
      value: JSON.stringify({ lastAt: now.getTime(), usedMemoryIds: [...state.usedMemoryIds, thread.id].slice(-50) } satisfies CheckinState),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.key],
      set: {
        value: JSON.stringify({ lastAt: now.getTime(), usedMemoryIds: [...state.usedMemoryIds, thread.id].slice(-50) } satisfies CheckinState),
        updatedAt: now,
      },
    })

  logger.info(`[companion:checkin] sent to user=${user.id} as ${characterName} (thread=${thread.category})`)
}
