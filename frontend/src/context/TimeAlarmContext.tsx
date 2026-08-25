// Global Time/Clock state + firing engine. Mounted once near the app root so
// alarms and running timers keep ticking, and can ring with a companion
// announcement + a Snooze/Dismiss dialog, no matter which page the user is on.
//
// Persistence split:
//   • locations / alarms / timer presets / running countdowns → server
//     (backend/src/routes/time.ts). Running countdowns are server-backed so the
//     companion can start/cancel live timers; the open app picks changes up via a
//     light poll (see POLL_MS) that merges server state without disturbing the
//     locally-driven countdown timing.
//   • stopwatch + active alarm snoozes → localStorage (purely client-side).

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { toast } from '@/lib/toast'
import { uuid } from '@/lib/uuid'
import { speak } from '@/lib/voice/voicePlaybackStore'
import { shouldSpeakProactively } from '@/lib/voice/dockYield'
import { getActiveCompanionId } from '@/hooks/useActiveCompanion'
import { startRinging, type RingHandle } from '@/lib/time/tones'
import * as api from '@/lib/time/api'
import type { ClockLocation, ClockAlarm, ClockTimer, TimerRun, AlarmInput, TimerInput } from '@/lib/time/api'

const TIMER_SNOOZE_MIN = 9
const POLL_MS = 4000
// Keep a just-created local run even if a concurrent poll predates its commit.
const CREATE_GRACE_MS = 6000

export interface StopwatchState {
  running: boolean
  startedAt: number | null   // epoch ms of the current run segment
  accumulatedMs: number      // elapsed before the current segment
  laps: number[]             // cumulative split times in ms (newest last)
}

export interface RingItem {
  kind: 'alarm' | 'timer'
  id: string
  label: string
  tone: string
  announce: boolean
  snoozeMinutes: number
  subtitle: string
  /** For timers: the original run length, so "Snooze" re-runs the same duration. */
  durationSec?: number
}

interface TimeAlarmValue {
  loading: boolean
  // data
  locations: ClockLocation[]
  alarms: ClockAlarm[]
  timers: ClockTimer[]
  // locations
  addLocation: (input: { label: string; timezone: string }) => Promise<void>
  removeLocation: (id: string) => Promise<void>
  // alarms
  saveAlarm: (input: Partial<AlarmInput>, id?: string) => Promise<void>
  toggleAlarm: (id: string, enabled: boolean) => Promise<void>
  removeAlarm: (id: string) => Promise<void>
  // timer presets
  saveTimerPreset: (input: Partial<TimerInput>, id?: string) => Promise<void>
  removeTimerPreset: (id: string) => Promise<void>
  // running timers (server-backed)
  running: TimerRun[]
  startTimer: (input: { label: string; tone: string; announce: boolean; durationSec: number; toneName?: string | null }) => void
  pauseTimer: (id: string) => void
  resumeTimer: (id: string) => void
  cancelTimer: (id: string) => void
  // stopwatch
  stopwatch: StopwatchState
  swStart: () => void
  swStop: () => void
  swReset: () => void
  swLap: () => void
  // ringing
  ringing: RingItem | null
  dismissRing: () => void
  snoozeRing: () => void
}

const TimeAlarmContext = createContext<TimeAlarmValue | null>(null)

const ZERO_SW: StopwatchState = { running: false, startedAt: null, accumulatedMs: 0, laps: [] }

function pad(n: number): string { return String(n).padStart(2, '0') }
function formatHM(h: number, m: number): string {
  const period = h >= 12 ? 'PM' : 'AM'
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr}:${pad(m)} ${period}`
}
function dayStamp(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

export function TimeAlarmProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id ?? null

  const [loading, setLoading] = useState(true)
  const [locations, setLocations] = useState<ClockLocation[]>([])
  const [alarms, setAlarms] = useState<ClockAlarm[]>([])
  const [timers, setTimers] = useState<ClockTimer[]>([])
  const [running, setRunning] = useState<TimerRun[]>([])
  const [stopwatch, setStopwatch] = useState<StopwatchState>(ZERO_SW)
  const [ringQueue, setRingQueue] = useState<RingItem[]>([])
  const [ringing, setRinging] = useState<RingItem | null>(null)

  // Refs mirror state so the 1s tick reads fresh values without re-subscribing.
  const alarmsRef = useRef(alarms); alarmsRef.current = alarms
  const runningRef = useRef(running); runningRef.current = running
  const snoozesRef = useRef<Map<string, number>>(new Map())
  const firedKeysRef = useRef<Set<string>>(new Set())
  const firedRunIdsRef = useRef<Set<string>>(new Set())
  const ringHandleRef = useRef<RingHandle | null>(null)

  // ── localStorage helpers (per-user) ─────────────────────────────────────────
  const lsKey = useCallback((kind: string) => `time.${kind}.${userId ?? 'anon'}`, [userId])

  const persistStopwatch = useCallback((sw: StopwatchState) => {
    if (!userId) return
    try { localStorage.setItem(lsKey('stopwatch'), JSON.stringify(sw)) } catch { /* quota */ }
  }, [userId, lsKey])
  const persistSnoozes = useCallback(() => {
    if (!userId) return
    try { localStorage.setItem(lsKey('snoozes'), JSON.stringify([...snoozesRef.current])) } catch { /* quota */ }
  }, [userId, lsKey])

  // Merge server runs into local state without disturbing locally-driven timing:
  // keep the local copy for runs we already track, adopt newly-appeared (e.g.
  // companion-started) runs, drop runs that vanished server-side (cancelled
  // elsewhere), and ignore ones we just fired. Stale-expired new runs are pruned.
  const reconcileRuns = useCallback((serverRuns: TimerRun[]) => {
    const now = Date.now()
    setRunning((prev) => {
      const prevById = new Map(prev.map((r) => [r.id, r]))
      const serverIds = new Set(serverRuns.map((r) => r.id))
      const result: TimerRun[] = []
      for (const s of serverRuns) {
        if (firedRunIdsRef.current.has(s.id)) continue
        const local = prevById.get(s.id)
        if (local) { result.push(local); continue }
        if (!s.paused && s.endsAt <= now) { void api.deleteRun(s.id).catch(() => {}); continue }
        result.push(s)
      }
      // Preserve very-recent local runs the poll may predate (create race).
      for (const local of prev) {
        if (!serverIds.has(local.id) && now - local.createdAt < CREATE_GRACE_MS && !firedRunIdsRef.current.has(local.id)) {
          result.push(local)
        }
      }
      return result
    })
  }, [])

  // ── Load server data + restore ephemeral state when the user changes ─────────
  useEffect(() => {
    if (!userId) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    Promise.all([api.listLocations(), api.listAlarms(), api.listTimers(), api.listRuns()])
      .then(([loc, al, tm, runs]) => {
        if (cancelled) return
        setLocations(loc); setAlarms(al); setTimers(tm)
        // Drop (and clean up) countdowns that already elapsed while the app was
        // closed; don't ring for stale timers; keep future + paused ones.
        const now = Date.now()
        const live: TimerRun[] = []
        for (const r of runs) {
          if (!r.paused && r.endsAt <= now) void api.deleteRun(r.id).catch(() => {})
          else live.push(r)
        }
        setRunning(live)
      })
      .catch(() => { if (!cancelled) toast.error('Could not load your clocks') })
      .finally(() => { if (!cancelled) setLoading(false) })

    try {
      const raw = localStorage.getItem(lsKey('stopwatch'))
      setStopwatch(raw ? JSON.parse(raw) : ZERO_SW)
    } catch { setStopwatch(ZERO_SW) }
    try {
      const raw = localStorage.getItem(lsKey('snoozes'))
      const entries: [string, number][] = raw ? JSON.parse(raw) : []
      snoozesRef.current = new Map(entries.filter(([, until]) => until > Date.now()))
    } catch { snoozesRef.current = new Map() }

    return () => { cancelled = true }
  }, [userId, lsKey])

  // ── Poll for server-side changes (companion edits, cross-tab, started runs) ───
  useEffect(() => {
    if (!userId) return
    const poll = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      Promise.all([api.listAlarms(), api.listTimers(), api.listRuns()])
        .then(([al, tm, runs]) => { setAlarms(al); setTimers(tm); reconcileRuns(runs) })
        .catch(() => { /* transient; next tick retries */ })
    }, POLL_MS)
    return () => window.clearInterval(poll)
  }, [userId, reconcileRuns])

  // ── Firing engine ────────────────────────────────────────────────────────────
  const enqueueRing = useCallback((item: RingItem) => {
    setRingQueue((q) => [...q, item])
  }, [])

  const toggleAlarm = useCallback(async (id: string, enabled: boolean) => {
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, enabled } : a)))
    try { await api.updateAlarm(id, { enabled }) } catch { toast.error('Could not update alarm') }
  }, [])

  useEffect(() => {
    if (!userId) return
    const tick = window.setInterval(() => {
      const now = new Date()
      const nowMs = now.getTime()

      // Scheduled alarms: fire within the first second of the matching minute.
      for (const a of alarmsRef.current) {
        if (!a.enabled) continue
        if (now.getHours() !== a.hour || now.getMinutes() !== a.minute || now.getSeconds() > 1) continue
        const dayMatch = a.repeatDays.length === 0 || a.repeatDays.includes(now.getDay())
        if (!dayMatch) continue
        const key = `${a.id}:${dayStamp(now)}:${a.hour}:${a.minute}`
        if (firedKeysRef.current.has(key)) continue
        firedKeysRef.current.add(key)
        enqueueRing({ kind: 'alarm', id: a.id, label: a.label, tone: a.tone, announce: a.announce, snoozeMinutes: a.snoozeMinutes, subtitle: formatHM(a.hour, a.minute) })
        if (a.repeatDays.length === 0) void toggleAlarm(a.id, false) // one-time alarms auto-disable
      }
      if (firedKeysRef.current.size > 80) firedKeysRef.current = new Set([...firedKeysRef.current].slice(-40))

      // Snoozed alarm re-fires.
      for (const [alarmId, until] of [...snoozesRef.current]) {
        if (nowMs < until) continue
        snoozesRef.current.delete(alarmId)
        persistSnoozes()
        const a = alarmsRef.current.find((x) => x.id === alarmId)
        if (a) enqueueRing({ kind: 'alarm', id: a.id, label: a.label, tone: a.tone, announce: a.announce, snoozeMinutes: a.snoozeMinutes, subtitle: formatHM(a.hour, a.minute) })
      }

      // Running countdowns reaching zero. Fire once, then remove + delete server-side.
      const expired = runningRef.current.filter((t) => !t.paused && t.endsAt <= nowMs && !firedRunIdsRef.current.has(t.id))
      if (expired.length) {
        for (const t of expired) {
          firedRunIdsRef.current.add(t.id)
          void api.deleteRun(t.id).catch(() => {})
          enqueueRing({ kind: 'timer', id: t.id, label: t.label, tone: t.tone, announce: t.announce, snoozeMinutes: TIMER_SNOOZE_MIN, subtitle: 'Timer', durationSec: t.durationSec })
        }
        setRunning((prev) => prev.filter((t) => !expired.some((e) => e.id === t.id)))
        if (firedRunIdsRef.current.size > 100) firedRunIdsRef.current = new Set([...firedRunIdsRef.current].slice(-50))
      }
    }, 1000)
    return () => window.clearInterval(tick)
  }, [userId, enqueueRing, persistSnoozes, toggleAlarm])

  // Pull the next item off the queue when nothing is ringing.
  useEffect(() => {
    if (ringing || ringQueue.length === 0) return
    setRinging(ringQueue[0]!)
    setRingQueue((q) => q.slice(1))
  }, [ringing, ringQueue])

  // Drive the actual sound + companion announcement for the active ring.
  useEffect(() => {
    if (!ringing) return
    ringHandleRef.current = startRinging(ringing.tone)
    // The tone rings on every surface (an alarm must never be silently missed), but the
    // spoken line is deduped per machine: a tab yielded to MaiPai Desktop stays quiet (the
    // dock's HUD announces), and within the dock only the HUD window speaks.
    if (ringing.announce && shouldSpeakProactively()) {
      const generic = !ringing.label || /^(alarm|timer)$/i.test(ringing.label.trim())
      const text = ringing.kind === 'alarm'
        ? (generic ? `It's ${ringing.subtitle}. Your alarm is going off.` : `It's ${ringing.subtitle}. Your alarm, ${ringing.label}, is going off.`)
        : (generic ? `Time's up! Your timer is done.` : `Time's up! Your ${ringing.label} timer is done.`)
      const characterId = getActiveCompanionId()
      void speak({ text, characterId }).catch(() => { /* TTS best-effort */ })
    }
    return () => {
      ringHandleRef.current?.stop()
      ringHandleRef.current = null
    }
  }, [ringing])

  // ── Running timers (server-backed) ───────────────────────────────────────────
  const startTimerImpl = useCallback((input: { label: string; tone: string; announce: boolean; durationSec: number; toneName?: string | null }) => {
    // Optimistic local run so the countdown starts instantly; replaced by the
    // server row (authoritative id/endsAt) once the POST resolves.
    const tempId = uuid()
    const optimistic: TimerRun = {
      id: tempId, label: input.label, tone: input.tone, toneName: input.toneName ?? null,
      announce: input.announce, durationSec: input.durationSec,
      endsAt: Date.now() + input.durationSec * 1000, paused: false,
      remainingMs: input.durationSec * 1000, createdAt: Date.now(),
    }
    setRunning((prev) => [...prev, optimistic])
    api.createRun(input)
      .then((run) => setRunning((prev) => prev.map((r) => (r.id === tempId ? run : r))))
      .catch(() => { setRunning((prev) => prev.filter((r) => r.id !== tempId)); toast.error('Could not start timer') })
  }, [])

  const dismissRing = useCallback(() => {
    setRinging(null)  // cleanup effect stops the sound; queue effect advances
  }, [])

  const snoozeRing = useCallback(() => {
    const r = ringing
    if (!r) return
    if (r.kind === 'alarm') {
      snoozesRef.current.set(r.id, Date.now() + r.snoozeMinutes * 60_000)
      persistSnoozes()
    } else {
      startTimerImpl({ label: r.label, tone: r.tone, announce: r.announce, durationSec: r.durationSec ?? r.snoozeMinutes * 60 })
    }
    setRinging(null)
  }, [ringing, persistSnoozes, startTimerImpl])

  const pauseTimer = useCallback((id: string) => {
    setRunning((prev) => prev.map((t) => (t.id === id && !t.paused ? { ...t, paused: true, remainingMs: Math.max(0, t.endsAt - Date.now()) } : t)))
    api.updateRun(id, { paused: true }).catch(() => {})
  }, [])

  const resumeTimer = useCallback((id: string) => {
    setRunning((prev) => prev.map((t) => (t.id === id && t.paused ? { ...t, paused: false, endsAt: Date.now() + t.remainingMs } : t)))
    api.updateRun(id, { paused: false }).catch(() => {})
  }, [])

  const cancelTimer = useCallback((id: string) => {
    setRunning((prev) => prev.filter((t) => t.id !== id))
    api.deleteRun(id).catch(() => {})
  }, [])

  // ── Stopwatch ──────────────────────────────────────────────────────────────────
  const swStart = useCallback(() => setStopwatch((sw) => {
    if (sw.running) return sw
    const next = { ...sw, running: true, startedAt: Date.now() }
    persistStopwatch(next); return next
  }), [persistStopwatch])
  const swStop = useCallback(() => setStopwatch((sw) => {
    if (!sw.running || sw.startedAt === null) return sw
    const next = { ...sw, running: false, startedAt: null, accumulatedMs: sw.accumulatedMs + (Date.now() - sw.startedAt) }
    persistStopwatch(next); return next
  }), [persistStopwatch])
  const swReset = useCallback(() => { persistStopwatch(ZERO_SW); setStopwatch(ZERO_SW) }, [persistStopwatch])
  const swLap = useCallback(() => setStopwatch((sw) => {
    const elapsed = sw.accumulatedMs + (sw.running && sw.startedAt ? Date.now() - sw.startedAt : 0)
    const next = { ...sw, laps: [...sw.laps, elapsed] }
    persistStopwatch(next); return next
  }), [persistStopwatch])

  // ── Server-backed CRUD ──────────────────────────────────────────────────────────
  const addLocation = useCallback(async (input: { label: string; timezone: string }) => {
    try { const loc = await api.createLocation(input); setLocations((p) => [...p, loc]) }
    catch { toast.error('Could not add clock') }
  }, [])
  const removeLocation = useCallback(async (id: string) => {
    setLocations((p) => p.filter((l) => l.id !== id))
    try { await api.deleteLocation(id) } catch { toast.error('Could not remove clock') }
  }, [])

  const saveAlarm = useCallback(async (input: Partial<AlarmInput>, id?: string) => {
    try {
      if (id) { const a = await api.updateAlarm(id, input); setAlarms((p) => p.map((x) => (x.id === id ? a : x))) }
      else { const a = await api.createAlarm(input); setAlarms((p) => [...p, a]) }
    } catch { toast.error('Could not save alarm') }
  }, [])
  const removeAlarm = useCallback(async (id: string) => {
    setAlarms((p) => p.filter((a) => a.id !== id))
    snoozesRef.current.delete(id); persistSnoozes()
    try { await api.deleteAlarm(id) } catch { toast.error('Could not remove alarm') }
  }, [persistSnoozes])

  const saveTimerPreset = useCallback(async (input: Partial<TimerInput>, id?: string) => {
    try {
      if (id) { const t = await api.updateTimer(id, input); setTimers((p) => p.map((x) => (x.id === id ? t : x))) }
      else { const t = await api.createTimer(input); setTimers((p) => [...p, t]) }
    } catch { toast.error('Could not save timer') }
  }, [])
  const removeTimerPreset = useCallback(async (id: string) => {
    setTimers((p) => p.filter((t) => t.id !== id))
    try { await api.deleteTimer(id) } catch { toast.error('Could not remove timer') }
  }, [])

  const value: TimeAlarmValue = {
    loading, locations, alarms, timers,
    addLocation, removeLocation,
    saveAlarm, toggleAlarm, removeAlarm,
    saveTimerPreset, removeTimerPreset,
    running, startTimer: startTimerImpl, pauseTimer, resumeTimer, cancelTimer,
    stopwatch, swStart, swStop, swReset, swLap,
    ringing, dismissRing, snoozeRing,
  }

  return <TimeAlarmContext.Provider value={value}>{children}</TimeAlarmContext.Provider>
}

export function useTimeApp(): TimeAlarmValue {
  const ctx = useContext(TimeAlarmContext)
  if (!ctx) throw new Error('useTimeApp must be used within TimeAlarmProvider')
  return ctx
}
