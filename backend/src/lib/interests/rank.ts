// Generic candidate ranker: blends embedding similarity against the profile centroids
// with creator affinity, topic overlap, upload freshness, and a per-bucket prior.
// Runs only inside background pool builds (it embeds every candidate title), never on
// a request path.

import { cosineSimilarity } from '@/llm/embed'
import { embedCached } from './embedCache'
import type { Candidate, InterestProfile, RankedCandidate } from './types'

export interface RankWeights {
  cos: number
  creator: number
  topic: number
  fresh: number
  bucket: number
}

const DEFAULT_WEIGHTS: RankWeights = { cos: 0.45, creator: 0.2, topic: 0.15, fresh: 0.1, bucket: 0.1 }

// Provenance prior: platform-picked related/similar items are stronger leads than a
// generic trending backfill.
const BUCKET_PRIOR: Record<Candidate['bucket'], number> = {
  related: 0.9,
  similar: 0.9,
  'topic-search': 0.85,
  'creator-latest': 0.8,
  trending: 0.5,
}

const FRESH_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000

const normKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

export async function rankCandidates(
  profile: InterestProfile,
  candidates: Candidate[],
  opts: { weights?: Partial<RankWeights> } = {},
): Promise<RankedCandidate[]> {
  const w: RankWeights = { ...DEFAULT_WEIGHTS, ...opts.weights }
  const now = Date.now()

  const creatorWeight = new Map<string, number>()
  for (const c of profile.creators) {
    if (c.id) creatorWeight.set(c.id, c.weight)
    creatorWeight.set(normKey(c.name), c.weight)
  }
  const topicWeight = new Map(profile.topics.map((t) => [normKey(t.text), t.weight]))

  const ranked: RankedCandidate[] = []
  for (const cand of candidates) {
    // Cosine vs the two-horizon centroids. A missing vector (embed failure) or a
    // profile without centroids scores neutral 0.5 so those candidates compete on the
    // other terms instead of sinking to the bottom.
    let cos = 0.5
    if (profile.recentCentroid || profile.longCentroid) {
      const vec = await embedCached(cand.creatorName ? `${cand.title} by ${cand.creatorName}` : cand.title)
      if (vec) {
        const recent = profile.recentCentroid ? cosineSimilarity(profile.recentCentroid, vec) : null
        const long = profile.longCentroid ? cosineSimilarity(profile.longCentroid, vec) : null
        const blend = recent !== null && long !== null ? 0.65 * recent + 0.35 * long : (recent ?? long)
        // nomic cosine lives in roughly [0.3, 0.9] for text pairs; stretch to ~[0, 1].
        if (blend !== null) cos = Math.min(1, Math.max(0, (blend - 0.3) / 0.6))
      }
    }

    const creator =
      (cand.creatorId && creatorWeight.get(cand.creatorId)) ||
      (cand.creatorName && creatorWeight.get(normKey(cand.creatorName))) ||
      0

    let topic = 0
    for (const t of cand.topics) {
      const hit = topicWeight.get(normKey(t))
      if (hit && hit > topic) topic = hit
    }

    const fresh = cand.publishedAt ? Math.pow(0.5, Math.max(0, now - cand.publishedAt) / FRESH_HALF_LIFE_MS) : 0.4

    const score =
      w.cos * cos + w.creator * creator + w.topic * topic + w.fresh * fresh + w.bucket * BUCKET_PRIOR[cand.bucket]
    ranked.push({ ...cand, score })
  }

  return ranked.sort((a, b) => b.score - a.score)
}

/** Greedy per-creator diversity cap (the nearestToVector maxPerArtist pattern): keeps one
 *  binge-watched channel from monopolizing a rail. Input must already be score-sorted. */
export function capPerCreator<T extends { creatorId: string | null; creatorName: string | null }>(
  sorted: T[],
  maxPerCreator: number,
): T[] {
  const counts = new Map<string, number>()
  const out: T[] = []
  for (const item of sorted) {
    const key = item.creatorId || (item.creatorName ? normKey(item.creatorName) : null)
    if (key) {
      const n = counts.get(key) ?? 0
      if (n >= maxPerCreator) continue
      counts.set(key, n + 1)
    }
    out.push(item)
  }
  return out
}
