import { and, asc, eq, gt, lt } from 'drizzle-orm'
import { db } from '@/db'
import { icloudCalendars, icloudEventOccurrences, users } from '@/db/schema'
import { isFeatureEnabled } from '@/lib/featureGate'
import { logger } from '@/lib/logger'

// Household-calendar grounding block for companion turns (iCloud plan M3). Mirrors
// the briefing pattern: a SYNCHRONOUS cache read on the turn path, refreshed in the
// background (by the sync poller and by a staleness kick here). One shared household
// block — identical for every member — so the prompt prefix stays KV-stable.

const TTL_MS = 10 * 60_000
const CHAR_CAP = 600
const WINDOW_DAYS = 7

const WEAVE_LINE =
  'Weave a calendar detail in only when relevant (their plans, "am I free", an event today); never recite the list unprompted.'

let cache: { block: string; at: number } | null = null
let inflight: Promise<void> | null = null

function dayLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function timeLabel(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

export async function refreshCalendarBlock(): Promise<void> {
  try {
    if (!(await isFeatureEnabled('icloud-calendar'))) {
      cache = { block: '', at: Date.now() }
      return
    }
    const now = new Date()
    const to = new Date(now.getTime() + WINDOW_DAYS * 86_400_000)
    const rows = await db
      .select({
        summary: icloudEventOccurrences.summary,
        startsAt: icloudEventOccurrences.startsAt,
        allDay: icloudEventOccurrences.allDay,
        member: users.nickname,
      })
      .from(icloudEventOccurrences)
      .innerJoin(icloudCalendars, and(
        eq(icloudEventOccurrences.calendarId, icloudCalendars.id),
        eq(icloudCalendars.enabled, true),
      ))
      .innerJoin(users, eq(icloudEventOccurrences.userId, users.id))
      .where(and(lt(icloudEventOccurrences.startsAt, to), gt(icloudEventOccurrences.endsAt, now)))
      .orderBy(asc(icloudEventOccurrences.startsAt))
      .limit(60)

    if (!rows.length) {
      cache = { block: '', at: Date.now() }
      return
    }

    // Group by day; each line "Wed Jul 23: Softball practice 5:00 PM (Isabella); …"
    const byDay = new Map<string, string[]>()
    for (const r of rows) {
      const day = dayLabel(r.startsAt)
      const when = r.allDay ? 'all day' : timeLabel(r.startsAt)
      const entry = `${(r.summary ?? 'Event').slice(0, 60)} ${when} (${r.member})`
      const list = byDay.get(day) ?? []
      if (list.length < 5) list.push(entry)
      byDay.set(day, list)
    }
    let lines = [...byDay.entries()].map(([day, entries]) => `${day}: ${entries.join('; ')}`)
    let body = `[Household calendar — next ${WINDOW_DAYS} days]\n${lines.join('\n')}`
    while (body.length > CHAR_CAP && lines.length > 1) {
      lines = lines.slice(0, -1)   // trim furthest-out days first
      body = `[Household calendar — next ${WINDOW_DAYS} days]\n${lines.join('\n')}`
    }
    cache = { block: `${body}\n${WEAVE_LINE}`, at: Date.now() }
  } catch (e) {
    logger.warn(`[icloud] calendar block refresh failed: ${e instanceof Error ? e.message : e}`)
    cache ??= { block: '', at: Date.now() }
  }
}

/** Synchronous cache read for the turn path; kicks a background refresh when stale.
 *  Returns '' until the first refresh lands (never blocks a companion turn). */
export function getCalendarBlock(): string {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    inflight ??= refreshCalendarBlock().finally(() => { inflight = null })
  }
  return cache?.block ?? ''
}
