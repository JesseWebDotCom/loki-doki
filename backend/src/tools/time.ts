// Companion tool for the Time/Clock app: create, change, and cancel alarms and
// timers by voice/chat. Alarms and timer presets are plain DB rows; live
// countdowns are rows in clock_timer_runs (the open Time app polls all three and
// rings them; see frontend/src/context/TimeAlarmContext.tsx). The tool resolves
// "my 7am alarm" / "the pasta timer" against the user's existing rows.

import type { Tool, ToolResult } from './index'
import { db } from '@/db'
import { clockAlarms, clockTimers, clockTimerRuns } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

interface TimeArgs {
  action?: string
  label?: string
  match?: string
  hour?: number | string
  minute?: number | string
  repeat?: string
  enabled?: boolean
  durationSec?: number | string
  duration?: string
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
function pad(n: number): string { return String(n).padStart(2, '0') }
function fmtHM(h: number, m: number): string {
  const period = h >= 12 ? 'PM' : 'AM'
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr}:${pad(m)} ${period}`
}

type Clock = { hour: number; minute: number }

function applyMeridiem(hour: number, minute: number, mer: string | null): Clock | null {
  let h = hour
  if (mer && /p/.test(mer) && h < 12) h += 12
  if (mer && /a/.test(mer) && h === 12) h = 0
  if (h > 23 || minute > 59) return null
  return { hour: h, minute }
}

type Meridiem = 'am' | 'pm' | null

/** The literal time a user wrote, with meridiem if stated. `hour` is as written
 *  (1–12 for a 12h reading, 0/13–23 for 24h). Handles "959", "9:51", "9:51 pm",
 *  "1330", "7am". Returns null if no clock time is present. */
function parseRawTime(text?: string): { hour: number; minute: number; mer: Meridiem } | null {
  if (!text) return null
  const t = text.toLowerCase()
  const merTok = (s?: string | null): Meridiem => (s ? (/p/.test(s) ? 'pm' : 'am') : null)
  const ctxMer: Meridiem = /\b(p\.?m\.?|evening|tonight|afternoon|night)\b/.test(t) ? 'pm'
    : /\b(a\.?m\.?|morning)\b/.test(t) ? 'am' : null
  let m = t.match(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/)
  if (m) return { hour: parseInt(m[1]!, 10), minute: parseInt(m[2]!, 10), mer: merTok(m[3]) ?? ctxMer }
  m = t.match(/\b(\d{3,4})\s*(a\.?m\.?|p\.?m\.?)?/)
  if (m) { const d = m[1]!; return { hour: parseInt(d.slice(0, -2), 10), minute: parseInt(d.slice(-2), 10), mer: merTok(m[2]) ?? ctxMer } }
  m = t.match(/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/)   // bare hour WITH meridiem ("7am")
  if (m) return { hour: parseInt(m[1]!, 10), minute: 0, mer: merTok(m[2]) }
  return null
}

/** Resolved clock time for `match`-style lookups (applies meridiem if present). */
function parseClock(text?: string): Clock | null {
  const p = parseRawTime(text)
  if (!p) return null
  return applyMeridiem(p.hour, p.minute, p.mer)
}

function occurrence(hour: number, minute: number, now: Date, dir: 'next' | 'last'): Date {
  const d = new Date(now)
  d.setHours(hour, minute, 0, 0)
  if (dir === 'next' && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  if (dir === 'last' && d.getTime() > now.getTime()) d.setDate(d.getDate() - 1)
  return d
}

type AlarmResolution = Clock | { confirm: string }

/** Resolve an alarm time, applying the "next upcoming" rule for am/pm-ambiguous
 *  times, and confirming when a matching reading slipped past in the last 5 min
 *  (so we don't silently jump ~12h to the next match). */
function resolveAlarm(a: TimeArgs, raw: string, now: Date): AlarmResolution | null {
  let hour: number | null = null, minute = 0, mer: Meridiem = null
  const fromText = parseRawTime(raw) ?? parseRawTime(a.match) ?? parseRawTime(a.label)
  if (fromText) { hour = fromText.hour; minute = fromText.minute; mer = fromText.mer }
  else if (num(a.hour) !== null) {
    hour = num(a.hour)!; minute = num(a.minute) ?? 0
    const t = raw.toLowerCase()
    mer = /\b(p\.?m\.?|evening|tonight|afternoon|night)\b/.test(t) ? 'pm'
      : /\b(a\.?m\.?|morning)\b/.test(t) ? 'am' : null
  }
  if (hour === null) return null

  // Unambiguous: meridiem stated, or a 24h hour (0 or 13–23). Store as-is.
  if (mer !== null || hour === 0 || hour > 12) {
    return applyMeridiem(hour, minute, mer)
  }

  // Ambiguous 1–12 with no meridiem → consider both AM and PM readings.
  const hAM = hour % 12            // 12 → 0 (midnight)
  const hPM = (hour % 12) + 12     // 9 → 21, 12 → 12 (noon)
  const minsSince = (d: Date) => (now.getTime() - d.getTime()) / 60_000
  const lastAM = minsSince(occurrence(hAM, minute, now, 'last'))
  const lastPM = minsSince(occurrence(hPM, minute, now, 'last'))
  if (lastAM < 5 || lastPM < 5) {
    const label = `${hour}:${pad(minute)}`
    return { confirm: `${label} just passed a few minutes ago. Did you mean ${label} AM or ${label} PM?` }
  }
  const pick = occurrence(hAM, minute, now, 'next').getTime() <= occurrence(hPM, minute, now, 'next').getTime() ? hAM : hPM
  return { hour: pick, minute }
}

/** Parse a duration phrase into seconds: "5 minutes", "1h 30m", "90s", "2:30". */
function parseDuration(text?: string): number | null {
  if (!text) return null
  const t = text.toLowerCase().trim()
  const clock = t.match(/^(\d{1,2}):(\d{2})$/)
  if (clock) return parseInt(clock[1]!, 10) * 60 + parseInt(clock[2]!, 10)
  let total = 0
  let found = false
  for (const [re, mult] of [[/(\d+)\s*h/, 3600], [/(\d+)\s*m(?!s)/, 60], [/(\d+)\s*s/, 1]] as const) {
    const m = t.match(re)
    if (m) { total += parseInt(m[1]!, 10) * mult; found = true }
  }
  if (found) return total
  const bare = t.match(/(\d+)/)
  return bare ? parseInt(bare[1]!, 10) * 60 : null  // bare number = minutes
}

function parseRepeat(text?: string): number[] {
  if (!text) return []
  const t = text.toLowerCase()
  if (/once|one ?time|no repeat/.test(t)) return []
  if (/every ?day|daily|all week/.test(t)) return [0, 1, 2, 3, 4, 5, 6]
  if (/weekday|week ?days/.test(t)) return [1, 2, 3, 4, 5]
  if (/weekend/.test(t)) return [0, 6]
  const days = new Set<number>()
  DAY_NAMES.forEach((d, i) => { if (t.includes(d)) days.add(i) })
  return [...days].sort((a, b) => a - b)
}

/** Find the row best matching `match` (label substring, then time, then sole row). */
function findByMatch<T extends { label: string }>(rows: T[], match: string | undefined, timeStr?: (r: T) => string): T | null {
  if (rows.length === 0) return null
  const m = (match ?? '').trim().toLowerCase()
  if (!m) return rows.length === 1 ? rows[0]! : null
  const byLabel = rows.find((r) => r.label.toLowerCase() === m) ?? rows.find((r) => r.label.toLowerCase().includes(m) || m.includes(r.label.toLowerCase()))
  if (byLabel) return byLabel
  if (timeStr) {
    const t = parseClock(m)
    if (t) { const hit = rows.find((r) => timeStr(r).includes(`${t.hour}:${pad(t.minute)}`)); if (hit) return hit }
  }
  return rows.length === 1 ? rows[0]! : null
}

export const timeTool: Tool = {
  id: 'time',
  name: 'Time',
  description: 'World clock, alarms, and timers; set or cancel them by voice too.',
  offline: true,
  dataSources: [],
  examples: [
    'set an alarm',
    'set an alarm for 7am',
    'set alarm for 9:51',
    'wake me up at 6:30 tomorrow',
    'change my alarm to 8am',
    'turn off my morning alarm',
    'delete my 7am alarm',
    'cancel that alarm',
    'cancel my alarm',
    'set a timer for 10 minutes',
    'start a 5 minute timer for the pasta',
    'cancel my timer',
    'how much time is left on my timer',
    'what alarms do I have',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'alarms_timers',
      description: 'Manage the user\'s alarms and timers. Use create_alarm/update_alarm/delete_alarm for clock alarms; start_timer to begin a countdown now; cancel_timer to stop a running countdown; create_timer/delete_timer for saved timer presets; list to read back what exists.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['create_alarm', 'update_alarm', 'delete_alarm', 'start_timer', 'cancel_timer', 'create_timer', 'delete_timer', 'list'],
            description: 'What to do. Pick by the noun the user used: an ALARM (a clock time) → create_alarm / update_alarm / delete_alarm. "cancel/delete/remove/turn off ... alarm" → delete_alarm. A TIMER (a countdown) → start_timer; "cancel/stop ... timer" → cancel_timer. create_timer/delete_timer manage SAVED timer presets. list reads back what exists.',
          },
          label: { type: 'string', description: 'Name for a new alarm/timer, or the new name when updating.' },
          match: { type: 'string', description: 'Which existing alarm/timer to act on for update/delete/cancel: its name or time (e.g. "pasta", "7am"). Use "all" to cancel every running timer.' },
          hour: { type: 'number', description: 'Alarm hour in 24h format (0–23). Convert "7am"→7, "6:30pm"→18.' },
          minute: { type: 'number', description: 'Alarm minute (0–59).' },
          repeat: { type: 'string', description: 'Alarm repeat: "once", "daily", "weekdays", "weekends", or day names like "mon, wed, fri".' },
          enabled: { type: 'boolean', description: 'Set false to turn an alarm off, true to turn it on (with update_alarm).' },
          durationSec: { type: 'number', description: 'Timer length in seconds. Convert "5 minutes"→300, "1 hour"→3600.' },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const userId = String(config?.['_userId'] ?? '')
    if (!userId) return { success: false, error: 'Not signed in.' }
    const a = (args ?? {}) as TimeArgs
    const raw = String(config?.['_rawMessage'] ?? '')

    try {
      switch (a.action) {
        case 'create_alarm': {
          const resolved = resolveAlarm(a, raw, new Date())
          if (!resolved) return { success: true, data: { needsTime: true }, directReply: 'What time should I set the alarm for? For example, 7:30 am.' }
          if ('confirm' in resolved) return { success: true, data: { needsConfirmation: true, question: resolved.confirm }, directReply: resolved.confirm }
          const hour = Math.max(0, Math.min(23, resolved.hour))
          const minute = Math.max(0, Math.min(59, resolved.minute))
          const repeatDays = parseRepeat(a.repeat ?? raw)
          const now = new Date()
          const id = crypto.randomUUID()
          await db.insert(clockAlarms).values({
            id, userId,
            label: (a.label ?? 'Alarm').toString().trim().slice(0, 80) || 'Alarm',
            hour, minute,
            repeatDays: JSON.stringify(repeatDays),
            enabled: true, tone: 'builtin:radar', toneName: null, announce: true, snoozeMinutes: 9,
            createdAt: now, updatedAt: now,
          })
          const when = repeatDays.length ? ' (repeating)' : ''
          return { success: true, data: { id, time: fmtHM(hour, minute) }, directReply: `Alarm set for ${fmtHM(hour, minute)}${when}.` }
        }

        case 'update_alarm': {
          const rows = await db.select().from(clockAlarms).where(eq(clockAlarms.userId, userId))
          const target = findByMatch(rows.map((r) => ({ ...r })), a.match ?? a.label, (r) => fmtHM(r.hour, r.minute))
          if (!target) {
            const list = rows.map((r) => `${fmtHM(r.hour, r.minute)} (${r.label})`).join(', ')
            return { success: true, data: { ambiguous: true }, directReply: rows.length ? `Which alarm: ${list}?` : 'You don\'t have any alarms set.' }
          }
          const patch: Partial<typeof clockAlarms.$inferInsert> = { updatedAt: new Date() }
          // Only change the time if the user actually gave a new one (apply the
          // same next-upcoming / confirm rule as create).
          const hasNewTime = !!(parseRawTime(raw) ?? parseRawTime(a.match)) || num(a.hour) !== null
          if (hasNewTime) {
            const resolved = resolveAlarm(a, raw, new Date())
            if (resolved && 'confirm' in resolved) return { success: true, data: { needsConfirmation: true, question: resolved.confirm }, directReply: resolved.confirm }
            if (resolved) { patch.hour = Math.max(0, Math.min(23, resolved.hour)); patch.minute = Math.max(0, Math.min(59, resolved.minute)) }
          }
          if (typeof a.repeat === 'string') patch.repeatDays = JSON.stringify(parseRepeat(a.repeat))
          if (typeof a.enabled === 'boolean') patch.enabled = a.enabled
          if (a.label && !parseClock(a.label)) patch.label = a.label.toString().trim().slice(0, 80)
          await db.update(clockAlarms).set(patch).where(and(eq(clockAlarms.id, target.id), eq(clockAlarms.userId, userId)))
          const hour = patch.hour ?? target.hour, minute = patch.minute ?? target.minute
          const reply = a.enabled === false ? `Turned off your ${target.label} alarm.`
            : a.enabled === true ? `Turned on your ${target.label} alarm for ${fmtHM(hour, minute)}.`
            : `Updated your ${target.label} alarm to ${fmtHM(hour, minute)}.`
          return { success: true, data: { id: target.id, time: fmtHM(hour, minute) }, directReply: reply }
        }

        case 'delete_alarm': {
          const rows = await db.select().from(clockAlarms).where(eq(clockAlarms.userId, userId))
          const target = findByMatch(rows.map((r) => ({ ...r })), a.match ?? a.label, (r) => fmtHM(r.hour, r.minute))
          if (!target) {
            const list = rows.map((r) => `${fmtHM(r.hour, r.minute)} (${r.label})`).join(', ')
            return { success: true, data: { ambiguous: true }, directReply: rows.length ? `Which alarm should I delete: ${list}?` : 'You don\'t have any alarms to delete.' }
          }
          await db.delete(clockAlarms).where(and(eq(clockAlarms.id, target.id), eq(clockAlarms.userId, userId)))
          return { success: true, data: { id: target.id }, directReply: `Deleted your ${target.label} alarm.` }
        }

        case 'start_timer': {
          const durationSec = num(a.durationSec) ?? parseDuration(a.duration) ?? parseDuration(a.match) ?? parseDuration(raw)
          if (!durationSec || durationSec < 1) return { success: true, data: { needsDuration: true }, directReply: 'How long should the timer run? For example, 10 minutes.' }
          const dur = Math.min(24 * 3600, Math.round(durationSec))
          const now = new Date()
          const id = crypto.randomUUID()
          await db.insert(clockTimerRuns).values({
            id, userId,
            label: (a.label ?? 'Timer').toString().trim().slice(0, 80) || 'Timer',
            tone: 'builtin:beacon', toneName: null, announce: true,
            durationSec: dur, endsAt: Date.now() + dur * 1000, paused: false, remainingMs: dur * 1000,
            createdAt: now,
          })
          const mins = Math.floor(dur / 60), secs = dur % 60
          const len = mins ? `${mins} minute${mins !== 1 ? 's' : ''}${secs ? ` ${secs} sec` : ''}` : `${secs} seconds`
          return { success: true, data: { id, durationSec: dur }, directReply: `Timer started for ${len}.` }
        }

        case 'cancel_timer': {
          const runs = await db.select().from(clockTimerRuns).where(eq(clockTimerRuns.userId, userId))
          if (runs.length === 0) return { success: true, data: {}, directReply: 'You don\'t have any running timers.' }
          const m = (a.match ?? '').toLowerCase()
          if (/\ball\b|both|every/.test(m) || (!m && runs.length > 1)) {
            await db.delete(clockTimerRuns).where(eq(clockTimerRuns.userId, userId))
            return { success: true, data: { cancelled: runs.length }, directReply: `Cancelled ${runs.length} timer${runs.length !== 1 ? 's' : ''}.` }
          }
          const target = findByMatch(runs.map((r) => ({ ...r })), a.match)
          if (!target) {
            const list = runs.map((r) => r.label).join(', ')
            return { success: true, data: { ambiguous: true }, directReply: `Which timer should I cancel: ${list}? Or say "all".` }
          }
          await db.delete(clockTimerRuns).where(and(eq(clockTimerRuns.id, target.id), eq(clockTimerRuns.userId, userId)))
          return { success: true, data: { id: target.id }, directReply: `Cancelled your ${target.label}.` }
        }

        case 'create_timer': {
          const durationSec = num(a.durationSec) ?? parseDuration(a.duration) ?? parseDuration(raw)
          if (!durationSec || durationSec < 1) return { success: true, data: { needsDuration: true }, directReply: 'How long should the timer be? For example, 10 minutes.' }
          const dur = Math.min(24 * 3600, Math.round(durationSec))
          const now = new Date()
          const id = crypto.randomUUID()
          await db.insert(clockTimers).values({
            id, userId,
            label: (a.label ?? 'Timer').toString().trim().slice(0, 80) || 'Timer',
            durationSec: dur, tone: 'builtin:beacon', toneName: null, announce: true, sortOrder: 0,
            createdAt: now, updatedAt: now,
          })
          return { success: true, data: { id, durationSec: dur }, directReply: `Saved a ${Math.round(dur / 60)}-minute timer preset.` }
        }

        case 'delete_timer': {
          const rows = await db.select().from(clockTimers).where(eq(clockTimers.userId, userId))
          const target = findByMatch(rows.map((r) => ({ ...r })), a.match ?? a.label)
          if (!target) {
            const list = rows.map((r) => r.label).join(', ')
            return { success: true, data: { ambiguous: true }, directReply: rows.length ? `Which saved timer should I delete: ${list}?` : 'You don\'t have any saved timers.' }
          }
          await db.delete(clockTimers).where(and(eq(clockTimers.id, target.id), eq(clockTimers.userId, userId)))
          return { success: true, data: { id: target.id }, directReply: `Deleted your ${target.label} timer.` }
        }

        case 'list': {
          const [alarms, runs] = await Promise.all([
            db.select().from(clockAlarms).where(eq(clockAlarms.userId, userId)),
            db.select().from(clockTimerRuns).where(eq(clockTimerRuns.userId, userId)),
          ])
          const now = Date.now()
          const alarmList = alarms.map((al) => ({ label: al.label, time: fmtHM(al.hour, al.minute), enabled: al.enabled }))
          const runList = runs.map((r) => ({ label: r.label, remainingSec: Math.max(0, Math.round((r.endsAt - now) / 1000)), paused: r.paused }))
          return { success: true, data: { alarms: alarmList, runningTimers: runList } }
        }

        default:
          return { success: false, error: `Unknown action: ${a.action}` }
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}
