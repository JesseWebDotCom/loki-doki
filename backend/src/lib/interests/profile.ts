// Interest profile builder. Two horizons on purpose: a recent centroid (~14-day
// half-life) captures what the user is into RIGHT NOW, a long centroid (flat over the
// signal window) keeps suggestions from whiplashing to only this week's binge. The
// ranker blends both, so a fresh interest surfaces fast without erasing standing tastes.

import { embedCached } from './embedCache'
import type { InterestDomain, InterestProfile, InterestSignal } from './types'
import { cachedLookupPut, cachedLookupStale } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

const NAMESPACE = 'interests:profile'
export const PROFILE_TTL_MS = 12 * 60 * 60 * 1000
const RECENT_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000
const MAX_CREATORS = 20
const MAX_TOPICS = 12
/** How many of the most-engaged signals feed the centroids (one embed call each). */
const CENTROID_SIGNALS = 60

const profileKey = (userId: string, domain: InterestDomain) => `${domain}:${userId}`

export async function getProfileStale(
  userId: string,
  domain: InterestDomain,
): Promise<{ profile: InterestProfile | undefined; fresh: boolean }> {
  const { value, fresh } = await cachedLookupStale<InterestProfile>(NAMESPACE, profileKey(userId, domain))
  return { profile: value ?? undefined, fresh }
}

/** Case/spacing-insensitive accumulation key for creators and topics. */
const normKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

function l2Normalize(vec: number[]): number[] {
  let mag = 0
  for (const v of vec) mag += v * v
  mag = Math.sqrt(mag)
  return mag === 0 ? vec : vec.map((v) => v / mag)
}

/**
 * Build and persist a profile from a domain's signals. `dismissedCreators` (creator key →
 * dismissal count, from suggestion_impressions) pushes back on creators whose suggestions
 * the user keeps waving off, even when their watch history still scores that creator high.
 */
export async function buildAndSaveProfile(
  userId: string,
  domain: InterestDomain,
  signals: InterestSignal[],
  dismissedCreators: Map<string, number>,
): Promise<InterestProfile> {
  const now = Date.now()
  const recentW = (s: InterestSignal) => s.engagement * Math.pow(0.5, Math.max(0, now - s.at) / RECENT_HALF_LIFE_MS)
  const longW = (s: InterestSignal) => s.engagement

  // Creators: decayed engagement, minus 0.5 per dismissal of that creator's suggestions.
  const creatorAcc = new Map<string, { id: string | null; name: string; weight: number }>()
  for (const s of signals) {
    const name = s.creatorName?.trim()
    if (!name) continue
    const key = s.creatorId || normKey(name)
    const cur = creatorAcc.get(key) ?? { id: s.creatorId, name, weight: 0 }
    cur.weight += 0.7 * recentW(s) + 0.3 * longW(s)
    if (!cur.id && s.creatorId) cur.id = s.creatorId
    creatorAcc.set(key, cur)
  }
  for (const [key, count] of dismissedCreators) {
    const cur = creatorAcc.get(key)
    if (cur) cur.weight -= 0.5 * count
  }
  const creators = [...creatorAcc.values()]
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_CREATORS)
  const maxCreator = creators[0]?.weight || 1
  for (const c of creators) c.weight = c.weight / maxCreator

  // Topics: same accumulation over whatever topic strings the signals already carry.
  const topicAcc = new Map<string, { text: string; weight: number }>()
  for (const s of signals) {
    const w = 0.7 * recentW(s) + 0.3 * longW(s)
    for (const t of s.topics) {
      const text = t.trim()
      if (text.length < 3) continue
      const key = normKey(text)
      const cur = topicAcc.get(key) ?? { text, weight: 0 }
      cur.weight += w
      topicAcc.set(key, cur)
    }
  }
  const topics = [...topicAcc.values()].sort((a, b) => b.weight - a.weight).slice(0, MAX_TOPICS)
  const maxTopic = topics[0]?.weight || 1
  for (const t of topics) t.weight = t.weight / maxTopic

  // Centroids: weighted mean of embedded titles for the most recently-engaged signals.
  const top = [...signals].sort((a, b) => recentW(b) - recentW(a)).slice(0, CENTROID_SIGNALS)
  let recentCentroid: number[] | null = null
  let longCentroid: number[] | null = null
  let recentSum = 0
  let longSum = 0
  for (const s of top) {
    const vec = await embedCached(s.creatorName ? `${s.title} by ${s.creatorName}` : s.title)
    if (!vec) continue
    const rw = recentW(s)
    const lw = longW(s)
    if (!recentCentroid) {
      recentCentroid = new Array<number>(vec.length).fill(0)
      longCentroid = new Array<number>(vec.length).fill(0)
    }
    if (vec.length !== recentCentroid.length) continue
    for (let i = 0; i < vec.length; i++) {
      recentCentroid[i]! += rw * vec[i]!
      longCentroid![i]! += lw * vec[i]!
    }
    recentSum += rw
    longSum += lw
  }
  if (recentCentroid && recentSum > 0) recentCentroid = l2Normalize(recentCentroid)
  else recentCentroid = null
  if (longCentroid && longSum > 0) longCentroid = l2Normalize(longCentroid)
  else longCentroid = null

  const profile: InterestProfile = {
    domain,
    builtAt: now,
    signalCount: signals.length,
    creators,
    topics,
    recentCentroid,
    longCentroid,
  }
  await cachedLookupPut(NAMESPACE, profileKey(userId, domain), PROFILE_TTL_MS, profile)
  logger.info(
    { domain, signals: signals.length, creators: creators.length, topics: topics.length, embedded: recentSum > 0 },
    'interests: profile built',
  )
  return profile
}
