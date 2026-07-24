import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { icloudAccounts, users } from '@/db/schema'
import { isFeatureEnabled } from '@/lib/featureGate'
import { emitNotification } from '@/lib/notify'
import { syncAccount } from '@/lib/icloud/calendarStore'
import { CalDavAuthError } from '@/lib/icloud/caldav'
import { logger } from '@/lib/logger'

// Periodic CalDAV sync (iCloud plan M2). Cheap by design: the ctag gate means a
// quiet tick costs one calendar-list PROPFIND per account. Auth failures need two
// consecutive strikes before flipping the account to auth_error (one 401 can be an
// Apple hiccup), then notify the admins once and stand down until a reconnect.

const TICK_MS = 5 * 60_000
const FIRST_RUN_DELAY_MS = 20_000
const AUTH_STRIKES_TO_FLIP = 2

const authStrikes = new Map<string, number>()
let running = false
let started = false

async function handleAuthFailure(account: { id: string; userId: string }): Promise<void> {
  const strikes = (authStrikes.get(account.id) ?? 0) + 1
  authStrikes.set(account.id, strikes)
  if (strikes < AUTH_STRIKES_TO_FLIP) return
  await db.update(icloudAccounts)
    .set({ caldavStatus: 'auth_error', lastError: 'Apple rejected the app-specific password (CalDAV)', updatedAt: new Date() })
    .where(eq(icloudAccounts.id, account.id))
  const [owner] = await db.select({ nickname: users.nickname }).from(users).where(eq(users.id, account.userId)).limit(1)
  await emitNotification({
    type: 'system',
    title: 'Apple iCloud needs reconnecting',
    body: `${owner?.nickname ?? 'A member'}'s Apple Account stopped accepting its app-specific password (this happens whenever the main Apple password changes). Reconnect it in Admin.`,
    url: '/admin/integrations/apple-icloud',
    dedupeKey: `icloud-auth-${account.id}`,
  })
  logger.warn(`[icloud] account ${account.id} flipped to auth_error after ${strikes} strikes`)
}

async function tick(): Promise<void> {
  if (running) return
  if (!(await isFeatureEnabled('icloud-calendar'))) return
  running = true
  try {
    const accounts = await db
      .select({ id: icloudAccounts.id, userId: icloudAccounts.userId, caldavStatus: icloudAccounts.caldavStatus })
      .from(icloudAccounts)
    for (const account of accounts) {
      if (account.caldavStatus === 'auth_error') continue   // stands down until reconnect re-probes
      try {
        const r = await syncAccount(account.id)
        authStrikes.delete(account.id)
        if (await isFeatureEnabled('icloud-contacts')) {
          const { syncContacts } = await import('@/lib/icloud/contactsStore')
          await syncContacts(account.id).catch((e) => {
            logger.warn(`[icloud] contacts sync failed (${account.id}): ${e instanceof Error ? e.message : e}`)
          })
        }
        if (r.eventsUpserted || r.eventsDeleted) {
          logger.info(`[icloud] synced account ${account.id}: +${r.eventsUpserted}/-${r.eventsDeleted} events, ${r.calendarsSynced} calendars`)
        }
      } catch (e) {
        if (e instanceof CalDavAuthError) await handleAuthFailure(account)
        else logger.warn(`[icloud] account sync failed (${account.id}): ${e instanceof Error ? e.message : e}`)
      }
    }
  } finally {
    running = false
  }
}

/** Manual "Sync now" from Admin — bypasses the ctag gate for immediate feedback. */
export async function syncAccountNow(accountId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await syncAccount(accountId, { force: true })
    authStrikes.delete(accountId)
    return { ok: true }
  } catch (e) {
    if (e instanceof CalDavAuthError) {
      const [account] = await db.select({ id: icloudAccounts.id, userId: icloudAccounts.userId })
        .from(icloudAccounts).where(eq(icloudAccounts.id, accountId)).limit(1)
      if (account) {
        authStrikes.set(accountId, AUTH_STRIKES_TO_FLIP - 1)   // manual failure = strong signal
        await handleAuthFailure(account)
      }
    }
    return { ok: false, error: e instanceof Error ? e.message : 'Sync failed' }
  }
}

export function startICloudCalendarPoller(): void {
  if (started) return
  started = true
  setTimeout(() => { void tick() }, FIRST_RUN_DELAY_MS)
  setInterval(() => { void tick() }, TICK_MS)
  logger.info('[icloud] calendar poller started')
}
