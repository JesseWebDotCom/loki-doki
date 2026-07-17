// Smart episode filters: a saved rule set evaluated over the user's podcast universe on
// every read (the music smartRules pattern - no persisted episode rows; the filter IS
// the query). The universe = ready episodes of every show the user can see (own shows,
// shared shows, RSS shows they subscribe to), with their watch/download state attached.

import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '@/db'
import { podcastDownloads, podcastEpisodes, podcastShows, podcastSubscriptions, podcastWatchState } from '@/db/schema'
import { filterEpisodesForUser } from '@/lib/podcast/policy'

export interface PodcastFilterRule {
  field: 'unplayed' | 'inProgress' | 'downloaded' | 'duration' | 'show' | 'releasedWithin'
  op?: 'lt' | 'gt' | 'in' | 'is'
  value?: number | string[]
}

export interface PodcastFilterRules {
  match: 'all' | 'any'
  limit?: number
  rules: PodcastFilterRule[]
}

export interface FilterEpisode {
  id: string
  showId: string
  showName: string
  title: string
  description: string | null
  durationSec: number | null
  publishedAt: Date | null
  generatedAt: Date | null
  createdAt: Date
  enclosureUrl: string | null
  explicit: number | null
  watchState: { positionSec: number; completed: boolean } | null
  download: { status: string; auto: boolean } | null
}

const DAY_MS = 86_400_000
const MAX_LIMIT = 200

export function parsePodcastFilterRules(json: string | null): PodcastFilterRules | null {
  if (!json) return null
  try {
    const p = JSON.parse(json) as Partial<PodcastFilterRules>
    if (!Array.isArray(p.rules)) return null
    return {
      match: p.match === 'any' ? 'any' : 'all',
      limit: typeof p.limit === 'number' ? Math.max(1, Math.min(MAX_LIMIT, p.limit)) : MAX_LIMIT,
      rules: p.rules.filter((r): r is PodcastFilterRule => !!r && typeof r === 'object' && 'field' in r),
    }
  } catch {
    return null
  }
}

function ruleMatches(e: FilterEpisode, r: PodcastFilterRule): boolean {
  switch (r.field) {
    case 'unplayed':
      return !e.watchState || (!e.watchState.completed && e.watchState.positionSec < 10)
    case 'inProgress':
      return !!e.watchState && !e.watchState.completed && e.watchState.positionSec >= 10
    case 'downloaded':
      return e.download?.status === 'ready'
    case 'duration': {
      const minutes = Number(r.value ?? 0)
      if (!minutes || e.durationSec == null) return false
      return r.op === 'lt' ? e.durationSec < minutes * 60 : e.durationSec > minutes * 60
    }
    case 'show': {
      const ids = Array.isArray(r.value) ? r.value : []
      return ids.length === 0 || ids.includes(e.showId)
    }
    case 'releasedWithin': {
      const days = Number(r.value ?? 0)
      if (!days) return true
      const ts = (e.publishedAt ?? e.generatedAt ?? e.createdAt)?.getTime() ?? 0
      return ts >= Date.now() - days * DAY_MS
    }
    default:
      return true
  }
}

/** Every show id the user can see episodes of (own + shared + subscribed RSS). */
async function visibleShowIds(userId: string): Promise<Map<string, string>> {
  const subs = await db.select({ showId: podcastSubscriptions.showId }).from(podcastSubscriptions)
    .where(eq(podcastSubscriptions.userId, userId))
  const subIds = subs.map(s => s.showId)
  const shows = await db.select({ id: podcastShows.id, name: podcastShows.name, source: podcastShows.source })
    .from(podcastShows)
    .where(or(
      eq(podcastShows.ownerUserId, userId),
      eq(podcastShows.visibility, 'shared'),
      ...(subIds.length ? [inArray(podcastShows.id, subIds)] : []),
    ))
  const subSet = new Set(subIds)
  const map = new Map<string, string>()
  for (const s of shows) {
    // RSS shows only count when this user subscribes (same rule as the shows list).
    if (s.source === 'rss' && !subSet.has(s.id)) continue
    map.set(s.id, s.name)
  }
  return map
}

export async function evaluatePodcastFilter(userId: string, rules: PodcastFilterRules): Promise<FilterEpisode[]> {
  const showNames = await visibleShowIds(userId)
  const showIds = [...showNames.keys()]
  if (!showIds.length) return []

  const episodesRaw = await db.select().from(podcastEpisodes)
    .where(and(inArray(podcastEpisodes.showId, showIds), eq(podcastEpisodes.status, 'ready')))
  // Kid-safe media: apply the same profile filter every episode list goes through.
  const episodes = await filterEpisodesForUser(userId, episodesRaw)

  const epIds = episodes.map(e => e.id)
  const watchRows: Array<{ episodeId: string; positionSec: number; completed: boolean }> = []
  const dlRows: Array<{ episodeId: string; status: string; auto: boolean }> = []
  for (let i = 0; i < epIds.length; i += 400) {
    const chunk = epIds.slice(i, i + 400)
    watchRows.push(...await db.select({
      episodeId: podcastWatchState.episodeId, positionSec: podcastWatchState.positionSec, completed: podcastWatchState.completed,
    }).from(podcastWatchState).where(and(eq(podcastWatchState.userId, userId), inArray(podcastWatchState.episodeId, chunk))))
    dlRows.push(...await db.select({
      episodeId: podcastDownloads.episodeId, status: podcastDownloads.status, auto: podcastDownloads.auto,
    }).from(podcastDownloads).where(and(eq(podcastDownloads.userId, userId), inArray(podcastDownloads.episodeId, chunk))))
  }
  const watchMap = new Map(watchRows.map(w => [w.episodeId, { positionSec: w.positionSec, completed: w.completed }]))
  const dlMap = new Map(dlRows.map(d => [d.episodeId, { status: d.status, auto: d.auto }]))

  const universe: FilterEpisode[] = episodes.map(e => ({
    id: e.id,
    showId: e.showId,
    showName: showNames.get(e.showId) ?? 'Show',
    title: e.title,
    description: e.description,
    durationSec: e.durationSec,
    publishedAt: e.publishedAt,
    generatedAt: e.generatedAt,
    createdAt: e.createdAt,
    enclosureUrl: e.enclosureUrl,
    explicit: e.explicit,
    watchState: watchMap.get(e.id) ?? null,
    download: dlMap.get(e.id) ?? null,
  }))

  const out = universe.filter(e =>
    rules.match === 'any'
      ? rules.rules.some(r => ruleMatches(e, r))
      : rules.rules.every(r => ruleMatches(e, r)),
  )
  const ts = (e: FilterEpisode) => (e.publishedAt ?? e.generatedAt ?? e.createdAt)?.getTime() ?? 0
  out.sort((a, b) => ts(b) - ts(a))
  return out.slice(0, rules.limit ?? MAX_LIMIT)
}
