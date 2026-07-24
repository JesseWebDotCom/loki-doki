// Apple iCloud integration API client (admin account management).

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export type ICloudProbeStatus = 'ok' | 'auth_error' | 'error' | 'unprobed'

export interface ICloudAccount {
  id: string
  userId: string
  userNickname: string
  appleId: string
  caldavStatus: ICloudProbeStatus
  imapStatus: ICloudProbeStatus
  lastProbeAt: string | null
  lastError: string | null
  createdAt: string
}

async function unwrap<T>(r: Response, key: string): Promise<T> {
  const body = await r.json().catch(() => null) as Record<string, unknown> | null
  if (!r.ok) throw new Error((body?.error as string) || 'Request failed')
  return body?.[key] as T
}

export async function listICloudAccounts(): Promise<ICloudAccount[]> {
  return unwrap(await fetch('/api/icloud/accounts', opts), 'accounts')
}

export async function connectICloudAccount(input: { userId: string; appleId: string; appPassword: string }): Promise<ICloudAccount> {
  const r = await fetch('/api/icloud/accounts', { ...opts, method: 'POST', headers: J, body: JSON.stringify(input) })
  return unwrap(r, 'account')
}

export async function probeICloudAccount(id: string): Promise<ICloudAccount> {
  const r = await fetch(`/api/icloud/accounts/${id}/probe`, { ...opts, method: 'POST' })
  return unwrap(r, 'account')
}

/** Reconnect with a fresh app-specific password. */
export async function reconnectICloudAccount(id: string, appPassword: string): Promise<ICloudAccount> {
  const r = await fetch(`/api/icloud/accounts/${id}`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ appPassword }) })
  return unwrap(r, 'account')
}

export async function disconnectICloudAccount(id: string): Promise<void> {
  const r = await fetch(`/api/icloud/accounts/${id}`, { ...opts, method: 'DELETE' })
  if (!r.ok) throw new Error('Request failed')
}

// ── Calendars (M2) ────────────────────────────────────────────────────────────

export interface ICloudCalendar {
  id: string
  accountId: string
  name: string
  colorHex: string | null
  enabled: boolean
  lastSyncAt: string | null
}

export async function listICloudCalendars(): Promise<ICloudCalendar[]> {
  return unwrap(await fetch('/api/icloud/calendars', opts), 'calendars')
}

export async function setICloudCalendarEnabled(id: string, enabled: boolean): Promise<void> {
  const r = await fetch(`/api/icloud/calendars/${id}`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ enabled }) })
  if (!r.ok) throw new Error('Request failed')
}

/** Force a full sync for one account (discovers calendars on a fresh connection). */
export async function syncICloudAccount(id: string): Promise<void> {
  const r = await fetch(`/api/icloud/accounts/${id}/sync`, { ...opts, method: 'POST' })
  if (!r.ok) {
    const body = await r.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error || 'Sync failed')
  }
}

// ── Calendar events (household view) ─────────────────────────────────────────

export interface ICloudEvent {
  id: string
  summary: string | null
  location: string | null
  startsAt: string
  endsAt: string
  allDay: boolean
  userId: string
  member: string
  colorHex: string | null
  calendarName: string
}

/** Merged household events in [from, to). Throws on 403 with a marker message so
 *  the Calendar app can render its "feature is off" state. */
export async function listICloudEvents(from: number, to: number): Promise<ICloudEvent[]> {
  const r = await fetch(`/api/icloud/calendar/events?from=${from}&to=${to}`, opts)
  if (r.status === 403) throw new Error('feature_disabled')
  return unwrap(r, 'events')
}

export interface ICloudBirthday {
  contactName: string
  member: string
  date: string          // YYYY-MM-DD
  turnsAge: number | null
}

/** Annual birthdays from synced contacts; [] when the contacts gate is off. */
export async function listICloudBirthdays(from: number, to: number): Promise<ICloudBirthday[]> {
  const r = await fetch(`/api/icloud/contacts/birthdays?from=${from}&to=${to}`, opts)
  if (!r.ok) return []
  return unwrap(r, 'birthdays')
}

// ── Mail (M4) ─────────────────────────────────────────────────────────────────

export interface ICloudMailAccountStatus {
  accountId: string
  userNickname: string
  watcherConnected: boolean
  watcherError: string | null
  messagesIndexed: number
}

/** Admin-only watcher status + counts; 403 while the icloud-mail feature is off. */
export async function getICloudMailStatus(): Promise<ICloudMailAccountStatus[] | null> {
  const r = await fetch('/api/icloud/mail/status', opts)
  if (r.status === 403) return null   // feature gated off
  return unwrap(r, 'accounts')
}

export interface ICloudMailVerdictRow {
  id: string
  bucket: 'ignore' | 'notify' | 'respond'
  method: 'heuristic' | 'llm' | 'rule'
  confidence: number
  reason: string
  model: string | null
  createdAt: string
  subject: string | null
  fromName: string | null
}

export interface ICloudMailVerdictAggregate {
  accountId: string
  bucket: 'ignore' | 'notify' | 'respond'
  method: 'heuristic' | 'llm' | 'rule'
  n: number
}

export interface ICloudMailVerdicts {
  own: ICloudMailVerdictRow[]
  aggregates: ICloudMailVerdictAggregate[]
}

/** Admin triage-tuning data: full rows for the admin's OWN mail + counts for all. */
export async function getICloudMailVerdicts(): Promise<ICloudMailVerdicts | null> {
  const r = await fetch('/api/icloud/mail/verdicts', opts)
  if (r.status === 403) return null
  const body = await r.json().catch(() => null) as ICloudMailVerdicts | null
  if (!r.ok || !body) throw new Error('Request failed')
  return body
}
