import { and, eq, sql } from 'drizzle-orm'
import type { ImapFlow } from 'imapflow'
import { db } from '@/db'
import { icloudMailFolders, icloudMailMessages, icloudSenderStats } from '@/db/schema'
import {
  fetchNewMessages, fetchSentRecipients, MAIL_FOLDERS, type FetchedMessage,
} from '@/lib/icloud/mail/imapClient'
import { logger } from '@/lib/logger'

// INBOX → headers-level index + sender stats; Sent Messages → replied-to counters
// (iCloud plan M4). Everything is cursor-based (per-folder lastSeenUid) and
// idempotent: a uidValidity change wipes the folder's rows and re-ingests.

const FIRST_SYNC_CAP = 200   // a fresh connection indexes the newest N, not years of mail

async function folderCursor(accountId: string, folder: string) {
  const [row] = await db.select().from(icloudMailFolders)
    .where(and(eq(icloudMailFolders.accountId, accountId), eq(icloudMailFolders.folder, folder)))
    .limit(1)
  if (row) return row
  const now = new Date()
  const fresh = {
    id: crypto.randomUUID(), accountId, folder, uidValidity: null,
    lastSeenUid: 0, lastSweepAt: null, createdAt: now, updatedAt: now,
  }
  await db.insert(icloudMailFolders).values(fresh)
  return { ...fresh }
}

async function saveCursor(id: string, uidValidity: number, lastSeenUid: number): Promise<void> {
  await db.update(icloudMailFolders)
    .set({ uidValidity, lastSeenUid, lastSweepAt: new Date(), updatedAt: new Date() })
    .where(eq(icloudMailFolders.id, id))
}

async function bumpSenderStats(accountId: string, messages: FetchedMessage[]): Promise<void> {
  for (const m of messages) {
    if (!m.fromAddress) continue
    await db.insert(icloudSenderStats)
      .values({
        id: crypto.randomUUID(), accountId, senderAddress: m.fromAddress,
        seenCount: 1, repliedCount: 0, firstSeenAt: m.receivedAt, lastSeenAt: m.receivedAt,
      })
      .onConflictDoUpdate({
        target: [icloudSenderStats.accountId, icloudSenderStats.senderAddress],
        set: {
          seenCount: sql`${icloudSenderStats.seenCount} + 1`,
          lastSeenAt: m.receivedAt,
        },
      })
  }
}

/** Ingest new INBOX messages for an account. Returns how many were added. */
export async function ingestInbox(accountId: string, client: ImapFlow): Promise<number> {
  const cursor = await folderCursor(accountId, MAIL_FOLDERS.inbox)
  let sinceUid = cursor.lastSeenUid
  const probe = await fetchNewMessages(client, MAIL_FOLDERS.inbox, sinceUid, {
    cap: cursor.uidValidity === null ? FIRST_SYNC_CAP : 500,
  })

  // UID space reset (or first contact): stored uids are meaningless — start over.
  if (cursor.uidValidity !== null && cursor.uidValidity !== probe.uidValidity) {
    logger.warn(`[icloud-mail] uidValidity changed for account ${accountId} INBOX; reindexing`)
    await db.delete(icloudMailMessages).where(and(
      eq(icloudMailMessages.accountId, accountId), eq(icloudMailMessages.folder, MAIL_FOLDERS.inbox),
    ))
    sinceUid = 0
  }

  const fresh = sinceUid === cursor.lastSeenUid
    ? probe
    : await fetchNewMessages(client, MAIL_FOLDERS.inbox, sinceUid, { cap: FIRST_SYNC_CAP })

  const now = new Date()
  let added = 0
  for (const m of fresh.messages) {
    await db.insert(icloudMailMessages)
      .values({
        id: crypto.randomUUID(), accountId, folder: MAIL_FOLDERS.inbox,
        uid: m.uid, messageId: m.messageId, fromAddress: m.fromAddress, fromName: m.fromName,
        subject: m.subject, snippet: m.snippet, receivedAt: m.receivedAt,
        seen: m.seen, answered: m.answered, listUnsubscribe: m.listUnsubscribe,
        authResults: m.authResults, hasAttachments: m.hasAttachments, createdAt: now,
      })
      .onConflictDoNothing()
    added++
  }
  await bumpSenderStats(accountId, fresh.messages)
  await saveCursor(cursor.id, fresh.uidValidity, Math.max(sinceUid, fresh.highestUid))
  return added
}

/** Incrementally scan Sent Messages and credit repliedCount per recipient. */
export async function ingestSentReplies(accountId: string, client: ImapFlow): Promise<void> {
  const cursor = await folderCursor(accountId, MAIL_FOLDERS.sent)
  let sinceUid = cursor.lastSeenUid
  const result = await fetchSentRecipients(client, sinceUid)
  if (cursor.uidValidity !== null && cursor.uidValidity !== result.uidValidity) sinceUid = 0

  const counts = new Map<string, number>()
  for (const addr of result.recipients) counts.set(addr, (counts.get(addr) ?? 0) + 1)
  const now = new Date()
  for (const [addr, n] of counts) {
    await db.insert(icloudSenderStats)
      .values({
        id: crypto.randomUUID(), accountId, senderAddress: addr,
        seenCount: 0, repliedCount: n, firstSeenAt: now, lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [icloudSenderStats.accountId, icloudSenderStats.senderAddress],
        set: { repliedCount: sql`${icloudSenderStats.repliedCount} + ${n}` },
      })
  }
  await saveCursor(cursor.id, result.uidValidity, Math.max(sinceUid, result.highestUid))
}
