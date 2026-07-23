import { eq } from 'drizzle-orm'
import type { ImapFlow } from 'imapflow'
import { db } from '@/db'
import { icloudAccounts, users } from '@/db/schema'
import { isFeatureEnabled } from '@/lib/featureGate'
import { emitNotification } from '@/lib/notify'
import { getAccountCredentials } from '@/lib/icloud/accounts'
import { createImapClient, MAIL_FOLDERS, logImapError } from '@/lib/icloud/mail/imapClient'
import { ingestInbox, ingestSentReplies } from '@/lib/icloud/mail/ingest'
import { logger } from '@/lib/logger'

// Per-account IMAP watchers (iCloud plan M4). imapflow auto-IDLEs whenever no
// command is running and emits 'exists' on new INBOX mail — that's the real-time
// path; a periodic sweep is the safety net for dropped IDLE pushes and for the
// Sent-folder replied-to counters. A supervisor tick reconciles running watchers
// against the feature gate + account set, so toggling the gate or reconnecting an
// account needs no restart.

const SUPERVISOR_TICK_MS = 60_000
const SWEEP_MS = 10 * 60_000
const RECONNECT_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000]
const AUTH_STRIKES_TO_FLIP = 2

interface Watcher {
  accountId: string
  client: ImapFlow | null
  stopped: boolean
  reconnectAttempt: number
  authStrikes: number
  sweepTimer: ReturnType<typeof setInterval> | null
  ingesting: boolean
  lastError: string | null
  connectedAt: number | null
}

const watchers = new Map<string, Watcher>()
let started = false

export interface MailWatcherStatus {
  accountId: string
  connected: boolean
  lastError: string | null
}

export function mailWatcherStatus(): MailWatcherStatus[] {
  return [...watchers.values()].map((w) => ({
    accountId: w.accountId,
    connected: !!w.client && w.connectedAt !== null,
    lastError: w.lastError,
  }))
}

async function flipAuthError(accountId: string): Promise<void> {
  await db.update(icloudAccounts)
    .set({ imapStatus: 'auth_error', lastError: 'Apple rejected the app-specific password (IMAP)', updatedAt: new Date() })
    .where(eq(icloudAccounts.id, accountId))
  const [row] = await db
    .select({ nickname: users.nickname })
    .from(icloudAccounts)
    .innerJoin(users, eq(icloudAccounts.userId, users.id))
    .where(eq(icloudAccounts.id, accountId))
    .limit(1)
  await emitNotification({
    type: 'system',
    title: 'Apple iCloud Mail needs reconnecting',
    body: `${row?.nickname ?? 'A member'}'s Apple Account stopped accepting its app-specific password for Mail. Reconnect it in Admin.`,
    url: '/admin/integrations/apple-icloud',
    dedupeKey: `icloud-mail-auth-${accountId}`,
  })
}

async function runIngest(w: Watcher, includeSent: boolean): Promise<void> {
  if (!w.client || w.ingesting) return
  w.ingesting = true
  try {
    const added = await ingestInbox(w.accountId, w.client)
    if (added > 0) logger.info(`[icloud-mail] account ${w.accountId}: +${added} messages`)
    if (includeSent) await ingestSentReplies(w.accountId, w.client)
    w.lastError = null
  } catch (e) {
    w.lastError = e instanceof Error ? e.message : String(e)
    logImapError(`ingest failed (${w.accountId})`, e)
  } finally {
    w.ingesting = false
  }
}

async function connect(w: Watcher): Promise<void> {
  if (w.stopped) return
  const creds = await getAccountCredentials(w.accountId)
  if (!creds) { stopWatcher(w.accountId); return }

  const client = createImapClient(creds)
  try {
    await client.connect()
  } catch (e) {
    client.close()   // a failed connect still leaves live socket handles behind
    if (e instanceof Error && (e as { authenticationFailed?: boolean }).authenticationFailed) {
      w.authStrikes++
    } else if (/authenticat/i.test(e instanceof Error ? e.message : '')) {
      w.authStrikes++
    }
    if (w.authStrikes >= AUTH_STRIKES_TO_FLIP) {
      await flipAuthError(w.accountId)
      stopWatcher(w.accountId)
      return
    }
    scheduleReconnect(w)
    return
  }

  w.client = client
  w.connectedAt = Date.now()
  w.reconnectAttempt = 0
  w.authStrikes = 0

  client.on('close', () => {
    w.client = null
    w.connectedAt = null
    if (!w.stopped) scheduleReconnect(w)
  })
  client.on('error', (e: Error) => { w.lastError = e.message })
  // New mail in the currently selected mailbox (INBOX — imapflow auto-idles there).
  client.on('exists', () => { void runIngest(w, false) })

  try {
    await client.mailboxOpen(MAIL_FOLDERS.inbox)
  } catch (e) {
    logImapError(`INBOX open failed (${w.accountId})`, e)
    client.close()
    return
  }

  await runIngest(w, true)   // initial catch-up incl. Sent backfill
  logger.info(`[icloud-mail] watcher connected for account ${w.accountId}`)
}

function scheduleReconnect(w: Watcher): void {
  if (w.stopped) return
  const delay = RECONNECT_BACKOFF_MS[Math.min(w.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]!
  w.reconnectAttempt++
  setTimeout(() => { void connect(w) }, delay)
}

function startWatcher(accountId: string): void {
  if (watchers.has(accountId)) return
  const w: Watcher = {
    accountId, client: null, stopped: false, reconnectAttempt: 0, authStrikes: 0,
    sweepTimer: null, ingesting: false, lastError: null, connectedAt: null,
  }
  watchers.set(accountId, w)
  w.sweepTimer = setInterval(() => {
    if (w.client) void runIngest(w, true)
    else if (!w.stopped) void connect(w)
  }, SWEEP_MS)
  void connect(w)
}

function stopWatcher(accountId: string): void {
  const w = watchers.get(accountId)
  if (!w) return
  w.stopped = true
  if (w.sweepTimer) clearInterval(w.sweepTimer)
  w.client?.close()
  watchers.delete(accountId)
}

/** Reconcile running watchers with the gate + healthy accounts. */
async function superviseTick(): Promise<void> {
  const enabled = await isFeatureEnabled('icloud-mail')
  if (!enabled) {
    for (const id of [...watchers.keys()]) stopWatcher(id)
    return
  }
  const accounts = await db
    .select({ id: icloudAccounts.id, imapStatus: icloudAccounts.imapStatus })
    .from(icloudAccounts)
  const wanted = new Set(accounts.filter((a) => a.imapStatus !== 'auth_error').map((a) => a.id))
  for (const id of [...watchers.keys()]) if (!wanted.has(id)) stopWatcher(id)
  for (const id of wanted) if (!watchers.has(id)) startWatcher(id)
}

export function startICloudMailWatchers(): void {
  if (started) return
  started = true
  setTimeout(() => { void superviseTick() }, 25_000)
  setInterval(() => { void superviseTick() }, SUPERVISOR_TICK_MS)
  logger.info('[icloud-mail] watcher supervisor started')
}
