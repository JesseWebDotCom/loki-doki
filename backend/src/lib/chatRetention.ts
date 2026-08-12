// Chat lifecycle sweeps, all sharing one hard-delete path:
// 1. Retention: a per-user auto-delete window for companion conversations, matching
//    the Siri app's month/year/forever control. Off by default (forever).
// 2. Recently-deleted purge: soft-deleted conversations are restorable for 30 days,
//    then removed for real.
// 3. Temporary (incognito) chats: purged once idle for over an hour.
// Hard deletes go through hardDeleteConversations, which deletes message rows
// explicitly so the messages_fts triggers definitely fire (FK cascade paths are
// not guaranteed to run triggers) and cleans up per-turn traces.

import { and, eq, lt, or, isNull, isNotNull, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { conversations, messages, messageTraces, userPreferences } from '@/db/schema'
import { logger } from '@/lib/logger'

export type RetentionPref = 'forever' | 'year' | 'month'

const WINDOW_MS: Record<Exclude<RetentionPref, 'forever'>, number> = {
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
}

const DELETED_RETENTION_MS = 30 * 86_400_000
const TEMPORARY_IDLE_MS = 3_600_000

function parseRetention(value: string): RetentionPref {
  try {
    const v = JSON.parse(value)
    return v === 'month' || v === 'year' ? v : 'forever'
  } catch {
    return 'forever'
  }
}

/** Hard-delete conversations: messages explicitly first (so the messages_fts
 *  DELETE triggers fire), then traces and the conversation rows. */
export async function hardDeleteConversations(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await db.delete(messages).where(inArray(messages.conversationId, ids))
  await db.delete(messageTraces).where(inArray(messageTraces.conversationId, ids))
  await db.delete(conversations).where(inArray(conversations.id, ids))
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
    const expired = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(
        eq(conversations.userId, row.userId),
        or(
          lt(conversations.updatedAt, cutoff),
          and(isNull(conversations.updatedAt), lt(conversations.createdAt, cutoff)),
        ),
      ))
    await hardDeleteConversations(expired.map((r) => r.id))
    deleted += expired.length
  }
  if (deleted > 0) logger.info(`[chat-retention] swept ${deleted} expired conversation(s)`)
  return deleted
}

/** Purge soft-deleted conversations past the 30-day bin and temporary (incognito)
 *  chats idle for over an hour. */
export async function purgeExpiredConversations(now = Date.now()): Promise<void> {
  try {
    const expiredDeleted = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(isNotNull(conversations.deletedAt), lt(conversations.deletedAt, new Date(now - DELETED_RETENTION_MS))))
    const tempCutoff = new Date(now - TEMPORARY_IDLE_MS)
    const staleTemporary = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(
        eq(conversations.temporary, true),
        or(
          lt(conversations.updatedAt, tempCutoff),
          and(isNull(conversations.updatedAt), lt(conversations.createdAt, tempCutoff)),
        ),
      ))
    const ids = [...expiredDeleted, ...staleTemporary].map((r) => r.id)
    if (ids.length > 0) {
      await hardDeleteConversations(ids)
      logger.info(`[chat] purged ${expiredDeleted.length} expired deleted + ${staleTemporary.length} stale temporary conversation(s)`)
    }
  } catch (err) {
    logger.warn(`[chat] conversation purge failed: ${err}`)
  }
}

/** Boot hook: sweep now, then daily. */
export function startChatRetentionSweep(): void {
  const run = () => {
    sweepChatRetention().catch((e) => logger.warn(`[chat-retention] sweep failed: ${e}`))
    void purgeExpiredConversations()
  }
  run()
  setInterval(run, 24 * 3_600_000)
}
