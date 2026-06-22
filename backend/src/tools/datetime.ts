import * as chrono from 'chrono-node'
import type { Tool, ToolResult } from './index'

// Parse any natural language date string against a reference (defaults to now).
// Handles: "tomorrow", "next Tuesday", "in 3 weeks", "last Monday", "Christmas",
// "day after tomorrow", "two days ago", "next New Year", "March 15", YYYY-MM-DD, etc.
function parseDate(expr: string, ref?: Date): Date | null {
  if (!expr) return null
  const result = chrono.parseDate(expr, ref ?? new Date(), { forwardDate: false })
  return result ?? null
}

function daysBetween(a: Date, b: Date): number {
  const aDay = new Date(a.getFullYear(), a.getMonth(), a.getDate())
  const bDay = new Date(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((bDay.getTime() - aDay.getTime()) / 86_400_000)
}

function longDate(d: Date, tz?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    ...(tz ? { timeZone: tz } : {}),
  }).format(d)
}

function shortTime(d: Date, tz?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    ...(tz ? { timeZone: tz } : {}),
  }).format(d)
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const datetimeTool: Tool = {
  id: 'datetime',
  name: 'Date & Time',
  description: 'Resolve natural language dates and perform date calculations. Accepts plain English like "next Tuesday", "in 3 weeks", "day after tomorrow", "Christmas", etc.',
  offline: true,
  dataSources: [],
  examples: [
    'current date, time, or day of the week right now',
    'how many days until or since a specific date or holiday',
    'what date is a relative expression like next Tuesday or in 3 weeks',
    'current time in another city or timezone',
    'date arithmetic — add or subtract days from a date',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'datetime',
      description: 'Date math and timezone queries. Accepts natural language for dates — pass exactly what the user said (e.g. "next Tuesday", "day after tomorrow", "Christmas", "in 3 weeks"). Use for: resolving a date expression, counting days until/since a date, adding days to a date, finding the weekday for a date, or the current time in another timezone.',
      parameters: {
        type: 'object',
        required: ['operation'],
        properties: {
          operation: {
            type: 'string',
            enum: ['current_time', 'resolve', 'days_until', 'days_since', 'days_between', 'add_days', 'day_of_week', 'time_in_timezone'],
            description: [
              'current_time: the current local date and time (no args needed — use for "what time is it", "what\'s the time", "what time is it now")',
              'resolve: convert a natural language date to a full calendar date (use for "what is tomorrow", "what is the day after tomorrow", "what is next Friday", etc.)',
              'days_until: days from today until date1',
              'days_since: days from date1 until today',
              'days_between: days from date1 to date2',
              'add_days: date1 + offset_days',
              'day_of_week: the weekday name for date1',
              'time_in_timezone: current time in another timezone (requires timezone arg)',
            ].join(' | '),
          },
          date1: {
            type: 'string',
            description: 'Natural language date expression: "tomorrow", "next Tuesday", "Christmas", "in 3 weeks", "March 15", "2027-07-04", etc.',
          },
          date2: {
            type: 'string',
            description: 'Second date expression, same format as date1 (required for days_between)',
          },
          offset_days: {
            type: 'number',
            description: 'Days to add (positive) or subtract (negative) for add_days',
          },
          timezone: {
            type: 'string',
            description: 'IANA timezone name, e.g. America/New_York, Asia/Tokyo, Europe/London, Australia/Sydney',
          },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { operation, date1, date2, offset_days, timezone } = args as {
      operation: string
      date1?: string
      date2?: string
      offset_days?: number
      timezone?: string
    }

    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    try {
      switch (operation) {
        case 'current_time': {
          const timeStr = shortTime(now)
          const dateStr = longDate(now)
          const gist = `${timeStr} — ${dateStr}`
          return { success: true, data: { time: timeStr, date: dateStr, answer_payload: { gist } } }
        }

        case 'resolve': {
          if (!date1) return { success: false, error: 'date1 required' }
          const d = parseDate(date1, now)
          if (!d) return { success: false, error: `Could not parse date: "${date1}"` }
          const formatted = longDate(d)
          return { success: true, data: { date: toIsoDate(d), formatted, answer_payload: { gist: formatted } } }
        }

        case 'days_until': {
          if (!date1) return { success: false, error: 'date1 required' }
          const target = parseDate(date1, now)
          if (!target) return { success: false, error: `Could not parse date: "${date1}"` }
          const days = daysBetween(today, target)
          const gist = days > 0
            ? `${days} day${days !== 1 ? 's' : ''} until ${longDate(target)}`
            : days === 0
              ? `${longDate(target)} is today`
              : `${longDate(target)} was ${Math.abs(days)} day${Math.abs(days) !== 1 ? 's' : ''} ago`
          return { success: true, data: { days, target: toIsoDate(target), target_formatted: longDate(target), answer_payload: { gist } } }
        }

        case 'days_since': {
          if (!date1) return { success: false, error: 'date1 required' }
          const from = parseDate(date1, now)
          if (!from) return { success: false, error: `Could not parse date: "${date1}"` }
          const days = daysBetween(from, today)
          const gist = days > 0
            ? `${days} day${days !== 1 ? 's' : ''} since ${longDate(from)}`
            : days === 0
              ? `${longDate(from)} is today`
              : `${longDate(from)} is ${Math.abs(days)} day${Math.abs(days) !== 1 ? 's' : ''} from now`
          return { success: true, data: { days, from: toIsoDate(from), from_formatted: longDate(from), answer_payload: { gist } } }
        }

        case 'days_between': {
          if (!date1 || !date2) return { success: false, error: 'date1 and date2 required' }
          const a = parseDate(date1, now)
          const b = parseDate(date2, now)
          if (!a) return { success: false, error: `Could not parse date: "${date1}"` }
          if (!b) return { success: false, error: `Could not parse date: "${date2}"` }
          const days = Math.abs(daysBetween(a, b))
          const gist = `${days} day${days !== 1 ? 's' : ''} between ${longDate(a)} and ${longDate(b)}`
          return { success: true, data: { days, from: toIsoDate(a), to: toIsoDate(b), answer_payload: { gist } } }
        }

        case 'add_days': {
          if (!date1 || offset_days === undefined) return { success: false, error: 'date1 and offset_days required' }
          const base = parseDate(date1, now)
          if (!base) return { success: false, error: `Could not parse date: "${date1}"` }
          const result = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset_days)
          const abs = Math.abs(offset_days)
          const dir = offset_days >= 0 ? 'after' : 'before'
          const gist = `${abs} day${abs !== 1 ? 's' : ''} ${dir} ${longDate(base)} is ${longDate(result)}`
          return { success: true, data: { result: toIsoDate(result), result_formatted: longDate(result), base: toIsoDate(base), offset_days, answer_payload: { gist } } }
        }

        case 'day_of_week': {
          if (!date1) return { success: false, error: 'date1 required' }
          const d = parseDate(date1, now)
          if (!d) return { success: false, error: `Could not parse date: "${date1}"` }
          const formatted = longDate(d)
          return { success: true, data: { date: toIsoDate(d), formatted, day_of_week: d.toLocaleDateString('en-US', { weekday: 'long' }), answer_payload: { gist: formatted } } }
        }

        case 'time_in_timezone': {
          if (!timezone) return { success: false, error: 'timezone required' }
          try {
            const timeStr = shortTime(now, timezone)
            const dateStr = longDate(now, timezone)
            const gist = `${timeStr} — ${dateStr} (${timezone})`
            return { success: true, data: { timezone, time: timeStr, date: dateStr, answer_payload: { gist } } }
          } catch {
            return { success: false, error: `Unknown timezone: "${timezone}"` }
          }
        }

        default:
          return { success: false, error: `Unknown operation: ${operation}` }
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}
