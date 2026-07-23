import { and, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { icloudAccounts, icloudCalendars, icloudEvents, icloudEventOccurrences } from '@/db/schema'
import { getAccountCredentials } from '@/lib/icloud/accounts'
import { listRemoteCalendars, fetchCalendarObjects, type CalDavCreds } from '@/lib/icloud/caldav'
import { parseEventMeta, expandOccurrences } from '@/lib/icloud/ics'
import { logger } from '@/lib/logger'

// Sync pipeline (iCloud plan M2): remote calendars → icloud_calendars, then per
// enabled calendar whose ctag moved: full object listing → href/etag diff against
// icloud_events → upsert/delete → occurrence window rebuilt from rawIcs. Every step
// is idempotent, so a crashed sync just redoes work on the next tick.

const WINDOW_BACK_DAYS = 7
const WINDOW_AHEAD_DAYS = 60

export interface AccountSyncResult {
  calendarsSynced: number
  calendarsSkipped: number
  eventsUpserted: number
  eventsDeleted: number
}

function windowRange(): { start: Date; end: Date } {
  const now = Date.now()
  return {
    start: new Date(now - WINDOW_BACK_DAYS * 86_400_000),
    end: new Date(now + WINDOW_AHEAD_DAYS * 86_400_000),
  }
}

/** Reconcile the account's calendar list, returning rows paired with fresh ctags. */
async function reconcileCalendars(accountId: string, creds: CalDavCreds) {
  const remote = await listRemoteCalendars(creds)
  const existing = await db.select().from(icloudCalendars).where(eq(icloudCalendars.accountId, accountId))
  const byUrl = new Map(existing.map((c) => [c.url, c]))
  const now = new Date()

  for (const cal of remote) {
    const row = byUrl.get(cal.url)
    if (!row) {
      await db.insert(icloudCalendars).values({
        id: crypto.randomUUID(), accountId, url: cal.url, name: cal.name,
        colorHex: cal.colorHex, createdAt: now, updatedAt: now,
      })
    } else if (row.name !== cal.name || row.colorHex !== cal.colorHex) {
      await db.update(icloudCalendars)
        .set({ name: cal.name, colorHex: cal.colorHex, updatedAt: now })
        .where(eq(icloudCalendars.id, row.id))
    }
  }
  // Calendars deleted on Apple's side disappear locally too (cascade takes the events).
  const remoteUrls = new Set(remote.map((c) => c.url))
  const gone = existing.filter((c) => !remoteUrls.has(c.url))
  if (gone.length) {
    const goneIds = gone.map((c) => c.id)
    await db.delete(icloudEventOccurrences).where(inArray(icloudEventOccurrences.calendarId, goneIds))
    await db.delete(icloudCalendars).where(inArray(icloudCalendars.id, goneIds))
  }

  const rows = await db.select().from(icloudCalendars).where(eq(icloudCalendars.accountId, accountId))
  const ctagByUrl = new Map(remote.map((c) => [c.url, c.ctag]))
  return rows.map((row) => ({ row, remoteCtag: ctagByUrl.get(row.url) ?? null }))
}

async function syncCalendarObjects(
  creds: CalDavCreds,
  cal: typeof icloudCalendars.$inferSelect,
  userId: string,
): Promise<{ upserted: number; deleted: number }> {
  const objects = await fetchCalendarObjects(creds, cal.url)
  const existing = await db
    .select({ id: icloudEvents.id, href: icloudEvents.href, etag: icloudEvents.etag })
    .from(icloudEvents).where(eq(icloudEvents.calendarId, cal.id))
  const existingByHref = new Map(existing.map((e) => [e.href, e]))
  const now = new Date()
  let upserted = 0

  for (const obj of objects) {
    const prior = existingByHref.get(obj.href)
    if (prior && prior.etag && prior.etag === obj.etag) continue
    const meta = parseEventMeta(obj.ics)
    if (!meta) continue
    const values = {
      uid: meta.uid, etag: obj.etag, summary: meta.summary, location: meta.location,
      allDay: meta.allDay, startsAt: meta.startsAt, endsAt: meta.endsAt,
      rrule: meta.rrule, status: meta.status, rawIcs: obj.ics, updatedAt: now,
    }
    if (prior) {
      await db.update(icloudEvents).set(values).where(eq(icloudEvents.id, prior.id))
    } else {
      await db.insert(icloudEvents).values({
        id: crypto.randomUUID(), calendarId: cal.id, href: obj.href, createdAt: now, ...values,
      })
    }
    upserted++
  }

  const remoteHrefs = new Set(objects.map((o) => o.href))
  const goneIds = existing.filter((e) => !remoteHrefs.has(e.href)).map((e) => e.id)
  if (goneIds.length) {
    await db.delete(icloudEventOccurrences).where(inArray(icloudEventOccurrences.eventId, goneIds))
    await db.delete(icloudEvents).where(inArray(icloudEvents.id, goneIds))
  }

  await rebuildOccurrences(cal.id, userId)
  return { upserted, deleted: goneIds.length }
}

/** Drop-and-regenerate the calendar's occurrence window from stored rawIcs. */
export async function rebuildOccurrences(calendarId: string, userId: string): Promise<void> {
  const { start, end } = windowRange()
  const events = await db.select().from(icloudEvents).where(eq(icloudEvents.calendarId, calendarId))
  const rows: (typeof icloudEventOccurrences.$inferInsert)[] = []
  for (const ev of events) {
    for (const occ of expandOccurrences(ev.rawIcs, start, end)) {
      rows.push({
        id: crypto.randomUUID(), eventId: ev.id, calendarId, userId,
        startsAt: occ.startsAt, endsAt: occ.endsAt, allDay: occ.allDay,
        summary: occ.summary ?? ev.summary, location: occ.location ?? ev.location,
      })
    }
  }
  db.transaction((tx) => {
    tx.delete(icloudEventOccurrences).where(eq(icloudEventOccurrences.calendarId, calendarId)).run()
    for (const row of rows) tx.insert(icloudEventOccurrences).values(row).run()
  })
}

/** Sync one account end to end. Throws CalDavAuthError upward for the poller. */
export async function syncAccount(accountId: string, opts: { force?: boolean } = {}): Promise<AccountSyncResult> {
  const [account] = await db.select().from(icloudAccounts).where(eq(icloudAccounts.id, accountId)).limit(1)
  const creds = await getAccountCredentials(accountId)
  if (!account || !creds) throw new Error('icloud account not found')

  const result: AccountSyncResult = { calendarsSynced: 0, calendarsSkipped: 0, eventsUpserted: 0, eventsDeleted: 0 }
  const calendars = await reconcileCalendars(accountId, creds)
  const now = new Date()

  for (const { row, remoteCtag } of calendars) {
    if (!row.enabled) { result.calendarsSkipped++; continue }
    // The occurrence window slides daily even when nothing changed, so a calendar
    // untouched for a week must still re-expand once a day.
    const windowStale = !row.lastSyncAt || now.getTime() - row.lastSyncAt.getTime() > 86_400_000
    const ctagMoved = opts.force || !remoteCtag || remoteCtag !== row.ctag
    if (!ctagMoved && !windowStale) { result.calendarsSkipped++; continue }

    try {
      if (ctagMoved) {
        const { upserted, deleted } = await syncCalendarObjects(creds, row, account.userId)
        result.eventsUpserted += upserted
        result.eventsDeleted += deleted
      } else {
        await rebuildOccurrences(row.id, account.userId)
      }
      await db.update(icloudCalendars)
        .set({ ctag: remoteCtag, lastSyncAt: now, updatedAt: now })
        .where(eq(icloudCalendars.id, row.id))
      result.calendarsSynced++
    } catch (e) {
      // Auth errors abort the whole account (every calendar will fail identically).
      if ((e as Error).name === 'CalDavAuthError' || e instanceof Error && /app-specific password/.test(e.message)) throw e
      logger.warn(`[icloud] calendar sync failed (${row.name}): ${e instanceof Error ? e.message : e}`)
    }
  }

  await db.update(icloudAccounts)
    .set({ caldavStatus: 'ok', lastError: null, updatedAt: now })
    .where(and(eq(icloudAccounts.id, accountId), eq(icloudAccounts.caldavStatus, 'error')))

  return result
}
