import { and, asc, eq, gt, lt } from 'drizzle-orm'
import { db } from '@/db'
import { icloudCalendars, icloudEventOccurrences, users } from '@/db/schema'
import { isFeatureEnabled } from '@/lib/featureGate'
import type { BriefingItem } from '../types'

// Today's household events from the locally synced iCloud calendars. Purely a DB
// read — the CalDAV sync poller owns freshness — so unlike every other briefing
// source this one contacts nothing external (manifest entry is []).

export async function todaysHouseholdEvents(limit: number): Promise<BriefingItem[]> {
  if (!(await isFeatureEnabled('icloud-calendar'))) return []
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const end = new Date(start.getTime() + 86_400_000)
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
    .where(and(lt(icloudEventOccurrences.startsAt, end), gt(icloudEventOccurrences.endsAt, start)))
    .orderBy(asc(icloudEventOccurrences.startsAt))
    .limit(limit)
  return rows.map((r) => ({
    title: `${r.summary ?? 'Event'} ${r.allDay ? 'all day' : r.startsAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} (${r.member})`,
  }))
}
