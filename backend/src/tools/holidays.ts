import type { Tool, ToolResult } from './index'

// Hybrid holidays tool: an offline fixed-date table answers common US holidays with no
// network; Nager.Date (https://date.nager.at, no API key) enriches with global coverage,
// movable holidays, and full per-country lists when online. Ported from maipai-home v1/v2.

const NAGER_API = 'https://date.nager.at/api/v3/PublicHolidays'

const COUNTRY_ALIASES: Record<string, string> = {
  us: 'US', usa: 'US', 'united states': 'US', america: 'US', american: 'US',
  uk: 'GB', 'united kingdom': 'GB', britain: 'GB', british: 'GB', england: 'GB',
  canada: 'CA', ca: 'CA', canadian: 'CA',
  australia: 'AU', au: 'AU', australian: 'AU',
  japan: 'JP', jp: 'JP', japanese: 'JP',
  germany: 'DE', de: 'DE', german: 'DE',
  france: 'FR', fr: 'FR', french: 'FR',
  mexico: 'MX', mx: 'MX', mexican: 'MX',
  india: 'IN', in: 'IN', indian: 'IN',
  ireland: 'IE', ie: 'IE', irish: 'IE',
  italy: 'IT', it: 'IT', italian: 'IT',
  spain: 'ES', es: 'ES', spanish: 'ES',
  brazil: 'BR', br: 'BR', brazilian: 'BR',
}

// US fixed-date holidays — instant, offline. Movable ones (Thanksgiving, Easter, MLK Day…)
// are intentionally absent: they require the online table.
const FIXED_US_HOLIDAYS: Record<string, [number, number]> = {
  "new year's day": [1, 1], 'new years day': [1, 1], 'new year': [1, 1],
  "valentine's day": [2, 14], 'valentines day': [2, 14],
  "st patrick's day": [3, 17], "saint patrick's day": [3, 17],
  juneteenth: [6, 19],
  'independence day': [7, 4], 'july fourth': [7, 4], 'fourth of july': [7, 4], '4th of july': [7, 4],
  halloween: [10, 31],
  'veterans day': [11, 11], "veteran's day": [11, 11],
  'christmas eve': [12, 24],
  christmas: [12, 25], 'christmas day': [12, 25], xmas: [12, 25],
  "new year's eve": [12, 31], 'new years eve': [12, 31],
}

const HOLIDAY_PREFIXES = [
  'what day is the', 'what date is the', 'what day does', 'when does',
  'what day is', 'what date is', 'when is the', 'when is', 'when',
  'how many days until', 'days until',
]
const HOLIDAY_SUFFIXES = [
  ' this year', ' next year', ' last year',
  ' in the us', ' in usa', ' in the usa', ' in america',
  ' fall on', ' fall', ' happen', ' celebrated', ' observed',
]

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function detectCountry(text: string, config?: Record<string, unknown>): string {
  const lower = text.toLowerCase()
  // longest alias first so "united states" wins over "us"
  for (const alias of Object.keys(COUNTRY_ALIASES).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) {
      return COUNTRY_ALIASES[alias]!
    }
  }
  const cfg = String(config?.country ?? '').trim()
  if (cfg) return COUNTRY_ALIASES[cfg.toLowerCase()] ?? cfg.toUpperCase()
  return 'US'
}

function detectYear(text: string): number {
  const now = new Date()
  const lower = text.toLowerCase()
  if (lower.includes('next year')) return now.getFullYear() + 1
  if (lower.includes('last year')) return now.getFullYear() - 1
  const m = lower.match(/\b(20\d{2})\b/)
  if (m) return parseInt(m[1]!, 10)
  return now.getFullYear()
}

function isListRequest(text: string): boolean {
  const lower = text.toLowerCase()
  if (/\b(list|all)\b/.test(lower) && lower.includes('holiday')) return true
  if (/\b(what|which|any)\b[^?]*\bholidays\b/.test(lower)) return true
  if (/\bholidays\b[^?]*\b(in|for|during)\b/.test(lower)) return true
  return false
}

function normalizeHolidayName(raw: string): string {
  let v = raw.toLowerCase().trim().replace(/^[\s?.!,'"]+|[\s?.!,'"]+$/g, '')
  for (const p of HOLIDAY_PREFIXES) {
    if (v.startsWith(p + ' ')) { v = v.slice(p.length).trim(); break }
  }
  for (const s of HOLIDAY_SUFFIXES) {
    if (v.endsWith(s)) { v = v.slice(0, -s.length).trim(); break }
  }
  // drop a trailing country phrase, e.g. "christmas in japan"
  v = v.replace(/\b(in|for)\s+[a-z .]+$/i, '').trim()
  return v
}

function formatDate(iso: string): { weekday: string; pretty: string } {
  const parts = iso.split('-').map(Number)
  const y = parts[0] ?? 1970, m = parts[1] ?? 1, d = parts[2] ?? 1
  const dt = new Date(Date.UTC(y, m - 1, d))
  const wd = WEEKDAYS[dt.getUTCDay()] ?? ''
  return {
    weekday: wd,
    pretty: `${wd}, ${MONTHS[m - 1] ?? ''} ${d}, ${y}`,
  }
}

interface NagerHoliday { name: string; date: string; global: boolean }

async function fetchNager(country: string, year: number): Promise<{ holidays: NagerHoliday[]; url: string } | null> {
  const url = `${NAGER_API}/${year}/${country}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MaiPaiHome/3' },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) return null
  const payload = await res.json() as Array<Record<string, unknown>>
  if (!Array.isArray(payload)) return null
  return {
    url,
    holidays: payload.map(item => ({
      name: String(item.localName || item.name || ''),
      date: String(item.date || ''),
      global: Boolean(item.global ?? true),
    })).filter(h => h.name && h.date),
  }
}

function matchHoliday(holidays: NagerHoliday[], requested: string): NagerHoliday | null {
  const q = compact(normalizeHolidayName(requested))
  if (!q) return null
  // Exact match wins outright; otherwise fall back to the first substring match.
  let partial: NagerHoliday | null = null
  for (const h of holidays) {
    const n = compact(h.name)
    if (n === q) return h
    if (!partial && (n.includes(q) || q.includes(n))) partial = h
  }
  return partial
}

function offlineLookup(holidayName: string, year: number): { name: string; date: string } | null {
  const q = compact(normalizeHolidayName(holidayName))
  if (!q) return null
  const build = (name: string, month: number, day: number) => ({
    // Capitalize each word's first letter only — leaves "year's" intact.
    name: name.replace(/(^|\s)\w/g, c => c.toUpperCase()),
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  })
  let partial: { name: string; date: string } | null = null
  for (const [name, [month, day]] of Object.entries(FIXED_US_HOLIDAYS)) {
    const n = compact(name)
    if (n === q) return build(name, month, day)
    if (!partial && (n.includes(q) || q.includes(n))) partial = build(name, month, day)
  }
  return partial
}

export const holidaysTool: Tool = {
  id: 'holidays',
  name: 'Holidays',
  description: 'Look up when a holiday falls, or list public holidays for a country and year (offline for common US holidays, global via Nager.Date when online)',
  offline: true,
  dataSources: [
    { name: 'Nager.Date', domain: 'date.nager.at', purpose: 'Public holiday dates for countries worldwide (used when online)', type: 'api' },
  ],
  passMessage: 'query',
  configSchema: [
    {
      key: 'country',
      label: 'Default Country',
      description: 'ISO country code used when no country is mentioned (e.g. US, GB, JP)',
      type: 'string' as const,
      scope: 'user' as const,
      default: 'US',
      placeholder: 'US',
    },
  ],
  examples: [
    'when is a specific holiday this year or next year',
    'what day does a holiday fall on',
    'list the public holidays for a country and year',
    'what holidays are coming up in a given country',
    'the date of a national or public holiday',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'holidays',
      description: 'Look up a holiday date or list public holidays for a country/year',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'The holiday question, e.g. "when is Christmas" or "holidays in Japan next year"' },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const a = (args ?? {}) as { query?: string }
    const text = (a.query ?? '').trim()
    if (!text) return { success: false, error: 'A holiday question is required' }

    const country = detectCountry(text, config)
    const year = detectYear(text)
    const listMode = isListRequest(text)

    // Fast offline path: a specific common US holiday with a fixed date.
    if (!listMode && country === 'US') {
      const hit = offlineLookup(text, year)
      if (hit) {
        const { weekday, pretty } = formatDate(hit.date)
        // Best-effort online enrich (more accurate localName), but never block on it.
        return {
          success: true,
          data: {
            mode: 'lookup', found: true, country, year,
            holiday: { name: hit.name, date: hit.date, weekday },
            answer_payload: {
              gist: `${hit.name} ${year} falls on ${pretty}.`,
              highlights: [], sources: [], depth_available: false,
            },
          },
        }
      }
    }

    // Online path (Nager.Date) for movable holidays, other countries, and full lists.
    let nager: Awaited<ReturnType<typeof fetchNager>> = null
    try {
      nager = await fetchNager(country, year)
    } catch {
      nager = null
    }

    if (!nager) {
      // Degrade gracefully to the offline table.
      if (listMode) {
        const seen = new Set<string>()
        const list = Object.entries(FIXED_US_HOLIDAYS)
          .map(([name, [m, d]]) => ({ name: name.replace(/(^|\s)\w/g, c => c.toUpperCase()), date: `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` }))
          .filter(h => { const k = h.date; if (seen.has(k)) return false; seen.add(k); return true })
          .sort((x, y) => x.date.localeCompare(y.date))
        return {
          success: true, offline: true,
          data: {
            mode: 'list', found: true, country: 'US', year, partial: true, holidays: list,
            answer_payload: {
              gist: `I'm offline, so here are common US holidays for ${year} (fixed dates only):`,
              highlights: list.map(h => `${h.name}: ${formatDate(h.date).pretty}`),
              sources: [], depth_available: false,
            },
          },
        }
      }
      const off = offlineLookup(text, year)
      if (off) {
        const { weekday, pretty } = formatDate(off.date)
        return {
          success: true, offline: true,
          data: {
            mode: 'lookup', found: true, country: 'US', year,
            holiday: { name: off.name, date: off.date, weekday },
            answer_payload: { gist: `${off.name} ${year} falls on ${pretty}.`, highlights: [], sources: [], depth_available: false },
          },
        }
      }
      return { success: false, offline: true, error: 'Holiday lookup needs an internet connection for that request.' }
    }

    const source = { url: nager.url, title: `Public holidays — ${country} ${year}` }

    if (listMode) {
      const sorted = [...nager.holidays].sort((x, y) => x.date.localeCompare(y.date))
      return {
        success: true,
        data: {
          mode: 'list', found: sorted.length > 0, country, year, holidays: sorted.map(h => ({ name: h.name, date: h.date, weekday: formatDate(h.date).weekday })),
          answer_payload: {
            gist: sorted.length ? `There are ${sorted.length} public holidays in ${country} for ${year}.` : `No public holidays found for ${country} in ${year}.`,
            highlights: sorted.slice(0, 12).map(h => `${h.name}: ${formatDate(h.date).pretty}`),
            sources: [source], depth_available: sorted.length > 12,
          },
        },
      }
    }

    const match = matchHoliday(nager.holidays, text)
    if (!match) {
      return {
        success: true,
        data: {
          mode: 'lookup', found: false, country, year,
          answer_payload: { gist: `I couldn't find that holiday in ${country} for ${year}.`, highlights: [], sources: [source], depth_available: false },
        },
      }
    }
    const { weekday, pretty } = formatDate(match.date)
    return {
      success: true,
      data: {
        mode: 'lookup', found: true, country, year,
        holiday: { name: match.name, date: match.date, weekday },
        answer_payload: { gist: `${match.name} in ${country} ${year} falls on ${pretty}.`, highlights: [], sources: [source], depth_available: false },
      },
    }
  },
}
