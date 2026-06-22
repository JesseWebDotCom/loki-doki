// Time / Clock app API client — world-clock locations, alarms, and timer presets.
// Mirrors the shape of the backend /api/time routes (see backend/src/routes/time.ts).

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export interface ClockLocation {
  id: string
  label: string
  timezone: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface ClockAlarm {
  id: string
  label: string
  hour: number
  minute: number
  repeatDays: number[]      // 0=Sun .. 6=Sat; [] = one-time
  enabled: boolean
  tone: string              // builtin:<key> | track:<id>
  toneName: string | null
  announce: boolean
  snoozeMinutes: number
  createdAt: number
  updatedAt: number
}

export interface ClockTimer {
  id: string
  label: string
  durationSec: number
  tone: string
  toneName: string | null
  announce: boolean
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface TimerRun {
  id: string
  label: string
  tone: string
  toneName: string | null
  announce: boolean
  durationSec: number
  endsAt: number          // epoch ms
  paused: boolean
  remainingMs: number
  createdAt: number
}

async function ok<T>(r: Response, key: string): Promise<T> {
  if (!r.ok) throw new Error(`time:${key}:${r.status}`)
  return (await r.json()) as T
}

// ── Locations ────────────────────────────────────────────────────────────────
export async function listLocations(): Promise<ClockLocation[]> {
  return (await ok<{ locations: ClockLocation[] }>(await fetch('/api/time/locations', opts), 'locations')).locations
}
export async function createLocation(input: { label: string; timezone: string }): Promise<ClockLocation> {
  const r = await fetch('/api/time/locations', { ...opts, method: 'POST', headers: J, body: JSON.stringify(input) })
  return (await ok<{ location: ClockLocation }>(r, 'create-location')).location
}
export async function updateLocation(id: string, patch: Partial<Pick<ClockLocation, 'label' | 'timezone' | 'sortOrder'>>): Promise<ClockLocation> {
  const r = await fetch(`/api/time/locations/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(patch) })
  return (await ok<{ location: ClockLocation }>(r, 'update-location')).location
}
export async function deleteLocation(id: string): Promise<void> {
  await ok(await fetch(`/api/time/locations/${id}`, { ...opts, method: 'DELETE' }), 'delete-location')
}

// ── Alarms ───────────────────────────────────────────────────────────────────
export type AlarmInput = Omit<ClockAlarm, 'id' | 'createdAt' | 'updatedAt'>

export async function listAlarms(): Promise<ClockAlarm[]> {
  return (await ok<{ alarms: ClockAlarm[] }>(await fetch('/api/time/alarms', opts), 'alarms')).alarms
}
export async function createAlarm(input: Partial<AlarmInput>): Promise<ClockAlarm> {
  const r = await fetch('/api/time/alarms', { ...opts, method: 'POST', headers: J, body: JSON.stringify(input) })
  return (await ok<{ alarm: ClockAlarm }>(r, 'create-alarm')).alarm
}
export async function updateAlarm(id: string, patch: Partial<AlarmInput>): Promise<ClockAlarm> {
  const r = await fetch(`/api/time/alarms/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(patch) })
  return (await ok<{ alarm: ClockAlarm }>(r, 'update-alarm')).alarm
}
export async function deleteAlarm(id: string): Promise<void> {
  await ok(await fetch(`/api/time/alarms/${id}`, { ...opts, method: 'DELETE' }), 'delete-alarm')
}

// ── Timer presets ──────────────────────────────────────────────────────────────
export type TimerInput = Omit<ClockTimer, 'id' | 'createdAt' | 'updatedAt'>

export async function listTimers(): Promise<ClockTimer[]> {
  return (await ok<{ timers: ClockTimer[] }>(await fetch('/api/time/timers', opts), 'timers')).timers
}
export async function createTimer(input: Partial<TimerInput>): Promise<ClockTimer> {
  const r = await fetch('/api/time/timers', { ...opts, method: 'POST', headers: J, body: JSON.stringify(input) })
  return (await ok<{ timer: ClockTimer }>(r, 'create-timer')).timer
}
export async function updateTimer(id: string, patch: Partial<TimerInput>): Promise<ClockTimer> {
  const r = await fetch(`/api/time/timers/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(patch) })
  return (await ok<{ timer: ClockTimer }>(r, 'update-timer')).timer
}
export async function deleteTimer(id: string): Promise<void> {
  await ok(await fetch(`/api/time/timers/${id}`, { ...opts, method: 'DELETE' }), 'delete-timer')
}

// ── Running timer countdowns (server-backed) ─────────────────────────────────────
export async function listRuns(): Promise<TimerRun[]> {
  return (await ok<{ runs: TimerRun[] }>(await fetch('/api/time/runs', opts), 'runs')).runs
}
export async function createRun(input: { label: string; tone: string; announce: boolean; durationSec: number; toneName?: string | null }): Promise<TimerRun> {
  const r = await fetch('/api/time/runs', { ...opts, method: 'POST', headers: J, body: JSON.stringify(input) })
  return (await ok<{ run: TimerRun }>(r, 'create-run')).run
}
export async function updateRun(id: string, patch: { paused?: boolean; label?: string }): Promise<TimerRun> {
  const r = await fetch(`/api/time/runs/${id}`, { ...opts, method: 'PATCH', headers: J, body: JSON.stringify(patch) })
  return (await ok<{ run: TimerRun }>(r, 'update-run')).run
}
export async function deleteRun(id: string): Promise<void> {
  await ok(await fetch(`/api/time/runs/${id}`, { ...opts, method: 'DELETE' }), 'delete-run')
}
