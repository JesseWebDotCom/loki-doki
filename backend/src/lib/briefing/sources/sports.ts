// Sports "what's on right now" via ESPN's free, no-key scoreboard API. We query a curated
// set of major leagues; only leagues actually in season return events, so the briefing
// naturally reflects the season (baseball in summer, World Cup when it's on, etc.).
// Shared by the briefing refresher and the sports reactive tool.

import type { BriefingItem } from '../types'

export interface LeagueRef {
  key: string // short label, e.g. "MLB", "World Cup"
  path: string // ESPN sport/league path, e.g. "baseball/mlb"
}

// Curated leagues. World Cup uses ESPN's "fifa.world" slug; off-cycle it simply returns
// no events and is skipped. MLS ("usa.1") keeps domestic soccer represented year-round.
export const DEFAULT_LEAGUES: LeagueRef[] = [
  { key: 'MLB', path: 'baseball/mlb' },
  { key: 'World Cup', path: 'soccer/fifa.world' },
  { key: 'NFL', path: 'football/nfl' },
  { key: 'NBA', path: 'basketball/nba' },
  { key: 'NHL', path: 'hockey/nhl' },
  { key: 'MLS', path: 'soccer/usa.1' },
]

interface EspnCompetitor {
  team?: { abbreviation?: string; displayName?: string; shortDisplayName?: string }
  score?: string
  winner?: boolean
}
interface EspnEvent {
  shortName?: string
  name?: string
  status?: { type?: { state?: string; shortDetail?: string; completed?: boolean } }
  competitions?: Array<{ competitors?: EspnCompetitor[] }>
}

function summarizeEvent(ev: EspnEvent): string | null {
  const label = ev.shortName || ev.name
  if (!label) return null
  const state = ev.status?.type?.state // 'pre' | 'in' | 'post'
  const detail = ev.status?.type?.shortDetail
  const comp = ev.competitions?.[0]
  const competitors = comp?.competitors ?? []

  // In-progress or final: include the score line.
  if ((state === 'in' || state === 'post') && competitors.length === 2) {
    const parts = competitors.map((c) => {
      const t = c.team?.abbreviation || c.team?.shortDisplayName || c.team?.displayName || '?'
      return `${t} ${c.score ?? ''}`.trim()
    })
    const tag = state === 'post' ? 'Final' : detail || 'live'
    return `${parts.join(' – ')} (${tag})`
  }
  // Upcoming: just the matchup + tip/first-pitch time.
  return detail ? `${label} (${detail})` : label
}

// 15-minute per-league cache of the raw scoreboard, so the sports route, the briefing
// refresher, and the boot warmer share ONE ESPN fetch per league instead of each paying
// their own (the route and briefing previously double-hit the same endpoints cold).
const SCOREBOARD_TTL_MS = 15 * 60 * 1000
const scoreboardCache = new Map<string, { events: EspnEvent[]; expiresAt: number }>()
const scoreboardInFlight = new Map<string, Promise<EspnEvent[]>>()

async function fetchScoreboard(league: LeagueRef, timeoutMs: number, date?: string): Promise<EspnEvent[]> {
  // `date` = YYYYMMDD (ESPN's `dates` param) for historical slates ("who won last
  // night"); omitted = today's board. Cached separately per (league, date).
  const cacheKey = `${league.path}:${date ?? 'today'}`
  const hit = scoreboardCache.get(cacheKey)
  if (hit && Date.now() < hit.expiresAt) return hit.events
  const inflight = scoreboardInFlight.get(cacheKey)
  if (inflight) return inflight
  const p = (async () => {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard${date ? `?dates=${date}` : ''}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'LokiDoki/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`sports ${league.key}: ${res.status}`)
    const data = (await res.json()) as { events?: EspnEvent[] }
    const events = Array.isArray(data.events) ? data.events : []
    // Past days never change — cache them much longer than the live board.
    const ttl = date ? 12 * 60 * 60 * 1000 : SCOREBOARD_TTL_MS
    scoreboardCache.set(cacheKey, { events, expiresAt: Date.now() + ttl })
    return events
  })()
  scoreboardInFlight.set(cacheKey, p)
  try { return await p } finally { scoreboardInFlight.delete(cacheKey) }
}

async function fetchLeague(league: LeagueRef, perLeague: number, timeoutMs: number, date?: string): Promise<BriefingItem[]> {
  const events = await fetchScoreboard(league, timeoutMs, date)
  // Prefer in-progress/final games over far-future ones for the briefing.
  const ranked = [...events].sort((a, b) => {
    const rank = (e: EspnEvent) => (e.status?.type?.state === 'in' ? 0 : e.status?.type?.state === 'post' ? 1 : 2)
    return rank(a) - rank(b)
  })
  const items: BriefingItem[] = []
  for (const ev of ranked.slice(0, perLeague)) {
    const s = summarizeEvent(ev)
    if (s) items.push({ title: `${league.key}: ${s}` })
  }
  return items
}

/**
 * Today's notable games across in-season leagues. `limit` caps the total items returned.
 * Per-league failures are swallowed (a league being off-season or erroring shouldn't sink
 * the rest); throws only if EVERY league fails, so the refresher can mark it degraded.
 */
export async function sportsToday(
  opts: { leagues?: LeagueRef[]; limit?: number; date?: string } = {},
  timeoutMs = 5000,
): Promise<BriefingItem[]> {
  const leagues = opts.leagues ?? DEFAULT_LEAGUES
  const limit = opts.limit ?? 4
  const settled = await Promise.allSettled(leagues.map((l) => fetchLeague(l, 2, timeoutMs, opts.date)))
  const ok = settled.filter((r): r is PromiseFulfilledResult<BriefingItem[]> => r.status === 'fulfilled')
  if (ok.length === 0) throw new Error('sports: all leagues failed')

  // Interleave one item per league first so a single busy league doesn't crowd out others.
  const byLeague = ok.map((r) => r.value).filter((v) => v.length > 0)
  const out: BriefingItem[] = []
  for (let i = 0; out.length < limit; i++) {
    let added = false
    for (const arr of byLeague) {
      if (arr[i]) {
        out.push(arr[i]!)
        added = true
        if (out.length >= limit) break
      }
    }
    if (!added) break
  }
  return out
}
