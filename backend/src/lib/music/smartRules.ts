// Smart playlists: a rule set evaluated over the user's music universe on every read -
// "my 5-star songs", "AC/DC I haven't played in a month", etc. No persisted track rows;
// the playlist IS the query. Fields are limited to what the universe actually knows
// (genre/year arrive with workstream D's analysis features).

import { getUserUniverse, type UniverseTrack } from '@/lib/music/libraryUniverse'

export interface SmartRule {
  field: 'artist' | 'title' | 'plays' | 'lastPlayed' | 'favorite' | 'rating'
  op: 'is' | 'contains' | 'gt' | 'lt' | 'gte' | 'before' | 'after' | 'isTrue'
  value?: string | number
}

export interface SmartRules {
  match: 'all' | 'any'
  limit?: number
  sort?: 'plays' | 'recent' | 'rating' | 'title'
  rules: SmartRule[]
}

const DAY_MS = 86_400_000

function ruleMatches(t: UniverseTrack, r: SmartRule): boolean {
  switch (r.field) {
    case 'artist': {
      const v = String(r.value ?? '').toLowerCase()
      if (!v) return true
      return r.op === 'is' ? t.artist.toLowerCase() === v : t.artist.toLowerCase().includes(v)
    }
    case 'title': {
      const v = String(r.value ?? '').toLowerCase()
      if (!v) return true
      return r.op === 'is' ? t.title.toLowerCase() === v : t.title.toLowerCase().includes(v)
    }
    case 'plays': {
      const n = Number(r.value ?? 0)
      return r.op === 'lt' ? t.playCount < n : r.op === 'gte' ? t.playCount >= n : t.playCount > n
    }
    case 'lastPlayed': {
      // value = days ago. before = older than N days (or never); after = within N days.
      const days = Number(r.value ?? 0)
      const cutoff = Date.now() - days * DAY_MS
      if (r.op === 'before') return t.lastPlayedMs == null || t.lastPlayedMs < cutoff
      return t.lastPlayedMs != null && t.lastPlayedMs >= cutoff
    }
    case 'favorite':
      return t.favorite
    case 'rating': {
      const n = Number(r.value ?? 0)
      if (t.stars == null) return false
      return r.op === 'is' ? t.stars === n : t.stars >= n
    }
    default:
      return true
  }
}

export function parseSmartRules(json: string | null): SmartRules | null {
  if (!json) return null
  try {
    const p = JSON.parse(json) as Partial<SmartRules>
    if (!Array.isArray(p.rules)) return null
    return {
      match: p.match === 'any' ? 'any' : 'all',
      limit: typeof p.limit === 'number' ? Math.max(1, Math.min(500, p.limit)) : 100,
      sort: p.sort ?? 'plays',
      rules: p.rules.filter((r): r is SmartRule => !!r && typeof r === 'object' && 'field' in r),
    }
  } catch {
    return null
  }
}

export function evaluateSmartPlaylist(userId: string, rules: SmartRules): UniverseTrack[] {
  const universe = getUserUniverse(userId)
  const out = universe.filter(t =>
    rules.match === 'any'
      ? rules.rules.some(r => ruleMatches(t, r))
      : rules.rules.every(r => ruleMatches(t, r)),
  )
  const sorters: Record<string, (a: UniverseTrack, b: UniverseTrack) => number> = {
    plays: (a, b) => b.playCount - a.playCount,
    recent: (a, b) => (b.lastPlayedMs ?? 0) - (a.lastPlayedMs ?? 0),
    rating: (a, b) => (b.stars ?? 0) - (a.stars ?? 0),
    title: (a, b) => a.title.localeCompare(b.title),
  }
  out.sort(sorters[rules.sort ?? 'plays'] ?? sorters.plays!)
  return out.slice(0, rules.limit ?? 100)
}
