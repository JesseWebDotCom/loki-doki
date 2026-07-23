import * as chrono from 'chrono-node'
import { and, asc, eq, gt, lt } from 'drizzle-orm'
import type { Tool, ToolResult } from './index'
import { db } from '@/db'
import { icloudCalendars, icloudEventOccurrences, users } from '@/db/schema'
import { isFeatureEnabled } from '@/lib/featureGate'

// Household calendar queries over the locally synced iCloud events (plan M3).
// Fully offline: reads the occurrences table, never the network. "when is X",
// "what's on Thursday", "is Isabella free Saturday" all resolve here; the synced
// window is -7d..+60d, so anything past that is honestly out of range.

function dayRange(query: string): { from: Date; to: Date; label: string } {
  const parsed = chrono.parse(query, new Date(), { forwardDate: true })
  if (parsed.length > 0) {
    const r = parsed[0]!
    const start = r.start.date()
    if (!r.start.isCertain('hour')) start.setHours(0, 0, 0, 0)
    // Explicit end ("Mon to Wed") wins; a certain day ("Thursday") = that day; a
    // vague point ("this week" — chrono emits no end) widens to a real range.
    let end: Date
    if (r.end) {
      end = r.end.date()
      if (!r.end.isCertain('hour')) end.setHours(23, 59, 59, 999)
    } else if (r.start.isCertain('day')) {
      end = new Date(start.getTime())
      end.setHours(23, 59, 59, 999)
    } else {
      const days = /weekend/i.test(r.text) ? 2 : 7
      end = new Date(start.getTime() + days * 86_400_000)
    }
    return { from: start, to: end, label: r.text }
  }
  const from = new Date()
  from.setHours(0, 0, 0, 0)
  return { from, to: new Date(from.getTime() + 7 * 86_400_000), label: 'the next 7 days' }
}

export const calendarTool: Tool = {
  id: 'calendar',
  name: 'Family Calendar',
  description: "Look up events on the family's synced iCloud calendars",
  offline: true,
  dataSources: [
    { name: 'Apple iCloud', domain: 'icloud.com', purpose: 'Family calendar events, synced locally over CalDAV', type: 'api' },
  ],
  examples: [
    'what is on my calendar today or this week',
    'when is the next practice, recital, game, or appointment',
    'is someone in the family free on a specific day',
    'what does the family schedule look like on Thursday',
    'do we have anything planned this weekend',
  ],
  passMessage: 'query',
  toolDefinition: {
    type: 'function',
    function: {
      name: 'calendar',
      description: "Look up events on the family's synced calendars for a day or range",
      parameters: {
        type: 'object',
        required: [],
        properties: {
          query: { type: 'string', description: 'The request, e.g. "what is on Thursday", "when is Isabella\'s recital"' },
          person: { type: 'string', description: 'Family member name to filter by, if one was mentioned' },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    if (!(await isFeatureEnabled('icloud-calendar'))) {
      return { success: false, error: 'The iCloud Calendar feature is turned off in Admin → Features' }
    }
    const { query = '', person } = args as { query?: string; person?: string }
    const { from, to, label } = dayRange(query)

    const rows = await db
      .select({
        summary: icloudEventOccurrences.summary,
        location: icloudEventOccurrences.location,
        startsAt: icloudEventOccurrences.startsAt,
        endsAt: icloudEventOccurrences.endsAt,
        allDay: icloudEventOccurrences.allDay,
        member: users.nickname,
        calendar: icloudCalendars.name,
      })
      .from(icloudEventOccurrences)
      .innerJoin(icloudCalendars, and(
        eq(icloudEventOccurrences.calendarId, icloudCalendars.id),
        eq(icloudCalendars.enabled, true),
      ))
      .innerJoin(users, eq(icloudEventOccurrences.userId, users.id))
      .where(and(lt(icloudEventOccurrences.startsAt, to), gt(icloudEventOccurrences.endsAt, from)))
      .orderBy(asc(icloudEventOccurrences.startsAt))
      .limit(50)

    // Person filter: an explicit arg, or a member nickname appearing in the query.
    const names = [...new Set(rows.map((r) => r.member))]
    const wanted = person?.trim().toLowerCase()
      || names.find((n) => new RegExp(`\\b${n}\\b`, 'i').test(query))?.toLowerCase()
    const filtered = wanted ? rows.filter((r) => r.member.toLowerCase() === wanted) : rows

    const events = filtered.map((r) => ({
      title: r.summary ?? 'Event',
      date: r.startsAt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
      time: r.allDay ? 'all day' : r.startsAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      member: r.member,
      ...(r.location ? { location: r.location } : {}),
    }))

    return {
      success: true,
      data: {
        range: label,
        ...(wanted ? { person: filtered[0]?.member ?? person } : {}),
        count: events.length,
        events,
        ...(events.length === 0 ? { note: `Nothing on the synced family calendars for ${label}` } : {}),
      },
    }
  },
}
