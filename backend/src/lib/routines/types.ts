// Routine trigger/action shapes, validation, and human-readable summaries.
//
// These are stored as JSON in the routines table. Validation is strict on create
// and update (a routine that can't run should never be saved), and tolerant on
// read (an unknown kind from a newer version is surfaced as invalid, not a crash).

export type RoutineTrigger =
  | { type: 'time'; time: string; days?: number[] } // HH:MM server-local; days 0-6 (Sun-Sat), absent = daily
  | { type: 'ha-state'; entityId: string; to?: string; from?: string; cooldownSec?: number }
  | { type: 'frigate'; camera?: string; label?: string; startHour?: number; endHour?: number; cooldownSec?: number }
  | { type: 'service'; monitor?: string; event?: 'down' | 'up' }
  | { type: 'webhook'; token: string }

export type RoutineAction =
  | { type: 'notify'; title: string; body?: string }
  | { type: 'announce'; text: string }
  | { type: 'ha-action'; action: string; entityIds: string[]; brightnessPct?: number; value?: number; hvacMode?: string }
  | { type: 'ask-companion'; prompt: string; deliver?: 'notify' | 'announce' }

export const TRIGGER_TYPES = ['time', 'ha-state', 'frigate', 'service', 'webhook'] as const
export const ACTION_TYPES = ['notify', 'announce', 'ha-action', 'ask-companion'] as const

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export function validateTrigger(t: unknown): { ok: true; trigger: RoutineTrigger } | { ok: false; error: string } {
  if (!t || typeof t !== 'object') return { ok: false, error: 'Trigger is required.' }
  const raw = t as Record<string, unknown>
  switch (raw.type) {
    case 'time': {
      if (typeof raw.time !== 'string' || !TIME_RE.test(raw.time)) return { ok: false, error: 'Time trigger needs a HH:MM time.' }
      if (raw.days !== undefined) {
        if (!Array.isArray(raw.days) || raw.days.some((d) => typeof d !== 'number' || d < 0 || d > 6)) {
          return { ok: false, error: 'days must be weekday numbers 0-6.' }
        }
      }
      return { ok: true, trigger: { type: 'time', time: raw.time, ...(Array.isArray(raw.days) && raw.days.length ? { days: raw.days as number[] } : {}) } }
    }
    case 'ha-state': {
      if (typeof raw.entityId !== 'string' || !raw.entityId.includes('.')) return { ok: false, error: 'Device trigger needs a Home Assistant entity id.' }
      return {
        ok: true,
        trigger: {
          type: 'ha-state', entityId: raw.entityId,
          ...(typeof raw.to === 'string' && raw.to ? { to: raw.to } : {}),
          ...(typeof raw.from === 'string' && raw.from ? { from: raw.from } : {}),
          ...(typeof raw.cooldownSec === 'number' ? { cooldownSec: Math.max(0, raw.cooldownSec) } : {}),
        },
      }
    }
    case 'frigate': {
      const hour = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 23
      return {
        ok: true,
        trigger: {
          type: 'frigate',
          ...(typeof raw.camera === 'string' && raw.camera ? { camera: raw.camera } : {}),
          ...(typeof raw.label === 'string' && raw.label ? { label: raw.label } : {}),
          ...(hour(raw.startHour) ? { startHour: raw.startHour as number } : {}),
          ...(hour(raw.endHour) ? { endHour: raw.endHour as number } : {}),
          ...(typeof raw.cooldownSec === 'number' ? { cooldownSec: Math.max(0, raw.cooldownSec) } : {}),
        },
      }
    }
    case 'service': {
      return {
        ok: true,
        trigger: {
          type: 'service',
          ...(typeof raw.monitor === 'string' && raw.monitor ? { monitor: raw.monitor } : {}),
          event: raw.event === 'up' ? 'up' : 'down',
        },
      }
    }
    case 'webhook': {
      // Token is server-generated; an incoming draft may omit it.
      const token = typeof raw.token === 'string' && raw.token.length >= 16 ? raw.token : crypto.randomUUID().replace(/-/g, '')
      return { ok: true, trigger: { type: 'webhook', token } }
    }
    default:
      return { ok: false, error: `Unknown trigger type: ${String(raw.type)}` }
  }
}

export function validateActions(list: unknown): { ok: true; actions: RoutineAction[] } | { ok: false; error: string } {
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: 'At least one action is required.' }
  if (list.length > 10) return { ok: false, error: 'A routine can have at most 10 actions.' }
  const actions: RoutineAction[] = []
  for (const item of list) {
    const raw = (item ?? {}) as Record<string, unknown>
    switch (raw.type) {
      case 'notify': {
        if (typeof raw.title !== 'string' || !raw.title.trim()) return { ok: false, error: 'Notify action needs a title.' }
        actions.push({ type: 'notify', title: raw.title.trim(), ...(typeof raw.body === 'string' && raw.body.trim() ? { body: raw.body.trim() } : {}) })
        break
      }
      case 'announce': {
        if (typeof raw.text !== 'string' || !raw.text.trim()) return { ok: false, error: 'Announce action needs text to speak.' }
        actions.push({ type: 'announce', text: raw.text.trim() })
        break
      }
      case 'ha-action': {
        if (typeof raw.action !== 'string' || !raw.action) return { ok: false, error: 'Home action needs an action name.' }
        if (!Array.isArray(raw.entityIds) || raw.entityIds.length === 0 || raw.entityIds.some((e) => typeof e !== 'string' || !e.includes('.'))) {
          return { ok: false, error: 'Home action needs at least one entity id.' }
        }
        actions.push({
          type: 'ha-action', action: raw.action, entityIds: raw.entityIds as string[],
          ...(typeof raw.brightnessPct === 'number' ? { brightnessPct: raw.brightnessPct } : {}),
          ...(typeof raw.value === 'number' ? { value: raw.value } : {}),
          ...(typeof raw.hvacMode === 'string' && raw.hvacMode ? { hvacMode: raw.hvacMode } : {}),
        })
        break
      }
      case 'ask-companion': {
        if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) return { ok: false, error: 'Ask-companion action needs a prompt.' }
        actions.push({ type: 'ask-companion', prompt: raw.prompt.trim(), deliver: raw.deliver === 'announce' ? 'announce' : 'notify' })
        break
      }
      default:
        return { ok: false, error: `Unknown action type: ${String(raw.type)}` }
    }
  }
  return { ok: true, actions }
}

// ── Human-readable summaries (UI cards, confirm dialogs, Telegram) ─────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function describeTrigger(t: RoutineTrigger): string {
  switch (t.type) {
    case 'time': {
      if (!t.days || t.days.length === 0 || t.days.length === 7) return `Every day at ${t.time}`
      if (t.days.length === 5 && !t.days.includes(0) && !t.days.includes(6)) return `Weekdays at ${t.time}`
      if (t.days.length === 2 && t.days.includes(0) && t.days.includes(6)) return `Weekends at ${t.time}`
      return `${t.days.map((d) => DAY_NAMES[d]).join(', ')} at ${t.time}`
    }
    case 'ha-state': {
      const change = t.to ? ` becomes ${t.to}` : ' changes'
      return `When ${t.entityId}${change}${t.from ? ` (from ${t.from})` : ''}`
    }
    case 'frigate': {
      const what = t.label ?? 'activity'
      const where = t.camera ? ` on the ${t.camera.replace(/_/g, ' ')} camera` : ' on any camera'
      const window = t.startHour != null && t.endHour != null ? ` between ${t.startHour}:00 and ${t.endHour}:00` : ''
      return `When a ${what} is seen${where}${window}`
    }
    case 'service':
      return `When ${t.monitor ?? 'any monitored service'} goes ${t.event ?? 'down'}`
    case 'webhook':
      return 'When its webhook is called'
  }
}

export function describeAction(a: RoutineAction): string {
  switch (a.type) {
    case 'notify': return `Notify: ${a.title}`
    case 'announce': return `Announce: "${a.text}"`
    case 'ha-action': return `Home: ${a.action.replace(/_/g, ' ')} ${a.entityIds.join(', ')}`
    case 'ask-companion': return `Ask the companion: "${a.prompt}"${a.deliver === 'announce' ? ' (spoken)' : ''}`
  }
}

export function describeRoutine(trigger: RoutineTrigger, actions: RoutineAction[]): string {
  return `${describeTrigger(trigger)} -> ${actions.map(describeAction).join('; ')}`
}
