import ICAL from 'ical.js'
import { logger } from '@/lib/logger'

// ICS parsing + windowed recurrence expansion (iCloud plan M2), on ical.js because
// its RecurExpansion honors RRULE + EXDATE + RECURRENCE-ID overrides. Everything is
// stored as UTC epochs plus an allDay flag; expansion happens in the timezone the
// event itself carries (iCloud embeds the VTIMEZONE in each object).

export interface ParsedEventMeta {
  uid: string
  summary: string | null
  location: string | null
  allDay: boolean
  startsAt: Date | null
  endsAt: Date | null
  rrule: boolean
  status: string | null
}

export interface ExpandedOccurrence {
  startsAt: Date
  endsAt: Date
  allDay: boolean
  summary: string | null
  location: string | null
}

/** Hard cap per event per window — a corrupt RRULE must not spin the poller. */
const MAX_OCCURRENCES = 500

function parseComponent(ics: string): ICAL.Component | null {
  try {
    const comp = new ICAL.Component(ICAL.parse(ics))
    for (const tzComp of comp.getAllSubcomponents('vtimezone')) {
      try {
        const tz = new ICAL.Timezone(tzComp)
        if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz.tzid, tz)
      } catch { /* unregisterable zone: ical.js falls back to floating time */ }
    }
    return comp
  } catch (e) {
    logger.warn(`[icloud] unparseable ICS skipped: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

/** The master VEVENT (no RECURRENCE-ID) with its overrides related for expansion. */
function masterEvent(comp: ICAL.Component): ICAL.Event | null {
  const vevents = comp.getAllSubcomponents('vevent')
  if (!vevents.length) return null
  const masterComp = vevents.find((v) => !v.hasProperty('recurrence-id')) ?? vevents[0]!
  const event = new ICAL.Event(masterComp)
  for (const v of vevents) {
    if (v === masterComp || !v.hasProperty('recurrence-id')) continue
    try { event.relateException(new ICAL.Event(v)) } catch { /* malformed override */ }
  }
  return event
}

export function parseEventMeta(ics: string): ParsedEventMeta | null {
  const comp = parseComponent(ics)
  const event = comp && masterEvent(comp)
  if (!event) return null
  const status = event.component.getFirstPropertyValue('status')
  return {
    uid: event.uid || crypto.randomUUID(),
    summary: event.summary || null,
    location: event.location || null,
    allDay: event.startDate?.isDate ?? false,
    startsAt: event.startDate ? event.startDate.toJSDate() : null,
    endsAt: event.endDate ? event.endDate.toJSDate() : null,
    rrule: event.isRecurring(),
    status: typeof status === 'string' ? status.toUpperCase() : null,
  }
}

export function expandOccurrences(ics: string, windowStart: Date, windowEnd: Date): ExpandedOccurrence[] {
  const comp = parseComponent(ics)
  const event = comp && masterEvent(comp)
  if (!event || !event.startDate) return []

  const status = event.component.getFirstPropertyValue('status')
  if (typeof status === 'string' && status.toUpperCase() === 'CANCELLED') return []

  const out: ExpandedOccurrence[] = []
  const push = (startsAt: Date, endsAt: Date, allDay: boolean, item: ICAL.Event) => {
    if (endsAt <= windowStart || startsAt >= windowEnd) return
    out.push({ startsAt, endsAt, allDay, summary: item.summary || null, location: item.location || null })
  }

  if (!event.isRecurring()) {
    const start = event.startDate.toJSDate()
    const end = event.endDate ? event.endDate.toJSDate() : start
    push(start, end, event.startDate.isDate, event)
    return out
  }

  try {
    const iterator = event.iterator()
    let next: ICAL.Time | null
    while ((next = iterator.next()) && out.length < MAX_OCCURRENCES) {
      const occTime = next.toJSDate()
      if (occTime >= windowEnd) break
      const details = event.getOccurrenceDetails(next)
      if (!details) continue
      const occStatus = details.item.component.getFirstPropertyValue('status')
      if (typeof occStatus === 'string' && occStatus.toUpperCase() === 'CANCELLED') continue
      push(
        details.startDate.toJSDate(),
        details.endDate ? details.endDate.toJSDate() : details.startDate.toJSDate(),
        details.startDate.isDate,
        details.item,
      )
    }
  } catch (e) {
    logger.warn(`[icloud] recurrence expansion failed for uid=${event.uid}: ${e instanceof Error ? e.message : e}`)
  }
  return out
}
