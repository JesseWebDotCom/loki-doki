import { DAVClient, type DAVCalendar } from 'tsdav'

// Thin tsdav wrapper (iCloud plan M2). Deliberately the ONLY module that touches
// tsdav, so a hand-rolled PROPFIND/REPORT client is a drop-in replacement if tsdav
// misbehaves on Bun. Sync strategy is ctag + etag diff rather than sync-token
// REPORTs: the ctag gate makes a no-change poll nearly free, and family-scale
// calendars are small enough that "ctag changed → refetch the calendar's objects
// and diff by href/etag" is simpler and immune to sync-token invalidation.

const CALDAV_BASE = process.env.ICLOUD_CALDAV_BASE ?? 'https://caldav.icloud.com'

export interface CalDavCreds {
  appleId: string
  password: string
}

export interface RemoteCalendar {
  url: string
  name: string
  colorHex: string | null
  ctag: string | null
}

export interface RemoteObject {
  href: string
  etag: string | null
  ics: string
}

export class CalDavAuthError extends Error {}

function isAuthError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /\b401\b|\b403\b|unauthorized|forbidden/i.test(msg)
}

async function makeClient(creds: CalDavCreds): Promise<DAVClient> {
  const client = new DAVClient({
    serverUrl: CALDAV_BASE,
    credentials: { username: creds.appleId, password: creds.password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  })
  try {
    await client.login()
  } catch (e) {
    if (isAuthError(e)) throw new CalDavAuthError('Apple rejected the app-specific password (CalDAV)')
    throw e
  }
  return client
}

/** Apple sends colors like "#FF2968FF" (RGBA); normalize to #RRGGBB. */
function normalizeColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = raw.trim().match(/^#?([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/)
  return m ? `#${m[1]!.toUpperCase()}` : null
}

function displayName(cal: DAVCalendar): string {
  if (typeof cal.displayName === 'string' && cal.displayName.trim()) return cal.displayName.trim()
  return 'Calendar'
}

export async function listRemoteCalendars(creds: CalDavCreds): Promise<RemoteCalendar[]> {
  const client = await makeClient(creds)
  const cals = await wrapAuth(() => client.fetchCalendars())
  return cals
    .filter((c) => !c.components || c.components.includes('VEVENT'))
    .map((c) => ({
      url: c.url,
      name: displayName(c),
      colorHex: normalizeColor(c.calendarColor),
      ctag: c.ctag ? String(c.ctag) : null,
    }))
}

/** Full object listing for one calendar (href + etag + ICS). Called only when the
 *  calendar's ctag moved, so this is the expensive path, not the steady state. */
export async function fetchCalendarObjects(creds: CalDavCreds, calendarUrl: string): Promise<RemoteObject[]> {
  const client = await makeClient(creds)
  const objects = await wrapAuth(() => client.fetchCalendarObjects({ calendar: { url: calendarUrl } }))
  return objects
    .filter((o) => typeof o.data === 'string' && o.data.includes('BEGIN:VEVENT'))
    .map((o) => ({ href: o.url, etag: o.etag ? String(o.etag) : null, ics: o.data as string }))
}

async function wrapAuth<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (isAuthError(e)) throw new CalDavAuthError('Apple rejected the app-specific password (CalDAV)')
    throw e
  }
}
