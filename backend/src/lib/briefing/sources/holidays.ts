// Today's holiday(s) for the briefing, via Nager.Date (no key). Only surfaces a holiday
// when today actually IS one — most days return []. Falls back silently on network error.

import type { BriefingItem } from '../types'

const NAGER_API = 'https://date.nager.at/api/v3/PublicHolidays'

interface NagerHoliday {
  name: string
  localName?: string
  date: string // YYYY-MM-DD
  global?: boolean
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Holidays falling on today for `country` (ISO code). Throws on network failure. */
export async function todaysHolidays(country = 'US', timeoutMs = 5000): Promise<BriefingItem[]> {
  const year = new Date().getFullYear()
  const res = await fetch(`${NAGER_API}/${year}/${country}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'MaiPaiHome/3' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`holidays: ${res.status}`)
  const payload = (await res.json()) as NagerHoliday[]
  if (!Array.isArray(payload)) return []
  const iso = todayIso()
  return payload
    .filter((h) => h.date === iso)
    .map((h) => ({ title: h.localName || h.name }))
}
