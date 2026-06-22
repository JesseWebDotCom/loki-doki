import type { Tool, ToolResult } from './index'

const SYNODIC_MONTH = 29.530588853
// Jan 6.6 2000 UT — a known new moon (Julian Day)
const KNOWN_NEW_MOON_JD = 2451550.1

function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5
}

function moonAge(date: Date): number {
  const jd = julianDay(date)
  return ((jd - KNOWN_NEW_MOON_JD) % SYNODIC_MONTH + SYNODIC_MONTH) % SYNODIC_MONTH
}

function moonIllumination(age: number): number {
  const half = SYNODIC_MONTH / 2
  const frac = age <= half
    ? (1 - Math.cos((age / half) * Math.PI)) / 2
    : (1 + Math.cos(((age - half) / half) * Math.PI)) / 2
  return Math.round(frac * 100)
}

function moonPhaseLabel(age: number): { phase: string; emoji: string } {
  if (age < 1.85)  return { phase: 'New Moon',        emoji: '🌑' }
  if (age < 7.38)  return { phase: 'Waxing Crescent', emoji: '🌒' }
  if (age < 9.22)  return { phase: 'First Quarter',   emoji: '🌓' }
  if (age < 14.77) return { phase: 'Waxing Gibbous',  emoji: '🌔' }
  if (age < 16.61) return { phase: 'Full Moon',        emoji: '🌕' }
  if (age < 22.15) return { phase: 'Waning Gibbous',  emoji: '🌖' }
  if (age < 23.99) return { phase: 'Last Quarter',    emoji: '🌗' }
  return             { phase: 'Waning Crescent',      emoji: '🌘' }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000)
}

function longDate(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export const moonphaseTool: Tool = {
  id: 'moonphase',
  name: 'Moon Phase',
  description: 'Current moon phase, illumination percentage, and upcoming moon events',
  offline: true,
  dataSources: [],
  examples: [
    'current moon phase or what phase is the moon in',
    'is there a full moon tonight or is it a full moon',
    'when is the next new moon or full moon',
    'how bright is the moon tonight',
    'lunar cycle — waxing crescent, first quarter, gibbous',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'moonphase',
      description: 'Get the current moon phase, illumination percentage, and upcoming full/new moon dates. No location required — moon phase is the same worldwide.',
      parameters: {
        type: 'object',
        required: [],
        properties: {
          date: {
            type: 'string',
            description: 'ISO date (YYYY-MM-DD) to check. Omit for today.',
          },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { date } = (args as { date?: string }) ?? {}
    const target = date ? new Date(date) : new Date()

    if (isNaN(target.getTime())) {
      return { success: false, error: `Invalid date: ${date}` }
    }

    const age = moonAge(target)
    const { phase, emoji } = moonPhaseLabel(age)
    const illumination = moonIllumination(age)

    // Days until next new moon and full moon
    const daysToNew = SYNODIC_MONTH - age
    const daysToFull = age <= SYNODIC_MONTH / 2
      ? SYNODIC_MONTH / 2 - age
      : SYNODIC_MONTH - age + SYNODIC_MONTH / 2

    const nextFullMoon = addDays(target, daysToFull)
    const nextNewMoon = addDays(target, daysToNew)

    const isToday = !date
    const gist = isToday
      ? `${emoji} ${phase} — ${illumination}% illuminated (day ${Math.round(age * 10) / 10} of ${SYNODIC_MONTH.toFixed(1)}-day cycle)`
      : `${emoji} ${phase} on ${longDate(target)} — ${illumination}% illuminated`

    return {
      success: true,
      data: {
        phase,
        emoji,
        illumination,
        age_days: Math.round(age * 10) / 10,
        is_full_moon: phase === 'Full Moon',
        is_new_moon: phase === 'New Moon',
        next_full_moon: toIsoDate(nextFullMoon),
        next_full_moon_formatted: longDate(nextFullMoon),
        days_until_full_moon: Math.ceil(daysToFull),
        next_new_moon: toIsoDate(nextNewMoon),
        next_new_moon_formatted: longDate(nextNewMoon),
        days_until_new_moon: Math.ceil(daysToNew),
        date: toIsoDate(target),
        answer_payload: { gist },
      },
    }
  },
}
