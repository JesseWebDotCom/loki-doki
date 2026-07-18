// Chat history retention: a per-user auto-delete window for companion conversations,
// matching the Siri app's month/year/forever control. Off by default (forever). A
// daily sweep deletes conversations whose last activity is older than the user's
// window; message rows cascade via the conversations foreign key. Purely local, and
// a direct privacy parity with Apple's assistant.

import { and, eq, lt, or, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { conversations, userPreferences } from '@/db/schema'
import { logger } from '@/lib/logger'

export type RetentionPref = 'forever' | 'year' | 'month'

const WINDOW_MS: Record<Exclude<RetentionPref, 'forever'>, number> = {
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
}

function parseRetention(value: string): RetentionPref {
  try {
    const v = JSON.parse(value)
    return v === 'month' || v === 'year' ? v : 'forever'
  } catch {
    return 'forever'
  }
}

/** Delete each user's conversations older than their retention window. */
export async function sweepChatRetention(now = Date.now()): Promise<number> {
  const rows = await db
    .select({ userId: userPreferences.userId, value: userPreferences.value })
    .from(userPreferences)
    .where(eq(userPreferences.key, 'chat.retention'))

  let deleted = 0
  for (const row of rows) {
    const pref = parseRetention(row.value)
    if (pref === 'forever') continue
    const cutoff = new Date(now - WINDOW_MS[pref])
    // Match on updatedAt when present, else createdAt (never-touched conversations
    // have a null updatedAt, and a NULL comparison would silently skip them).
    const res = await db
      .delete(conversations)
      .where(and(
        eq(conversations.userId, row.userId),
        or(
          lt(conversations.updatedAt, cutoff),
          and(isNull(conversations.updatedAt), lt(conversations.createdAt, cutoff)),
        ),
      ))
    deleted += (res as { changes?: number }).changes ?? 0
  }
  if (deleted > 0) logger.info(`[chat-retention] swept ${deleted} expired conversation(s)`)
  return deleted
}

/** Boot hook: sweep now, then daily. */
export function startChatRetentionSweep(): void {
  const run = () => {
    sweepChatRetention().catch((e) => logger.warn(`[chat-retention] sweep failed: ${e}`))
  }
  run()
  setInterval(run, 24 * 3_600_000)
}
