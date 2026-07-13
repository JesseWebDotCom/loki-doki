// Kid-safe media: podcast content filtering. Two layers, mirroring the video path:
//   • explicit flag — the publisher's self-declared <itunes:explicit> (persisted on
//     podcast_episodes.explicit), blocked when the profile blocks explicit.
//   • topical classifier — the profile's dial ceiling applied to the episode's title +
//     description, catching mature-topic shows that carry no explicit tag (the common case,
//     since publishers set the tag inconsistently). On a kid tier, an episode with neither a
//     clean explicit tag nor a classifier verdict is hidden until the background pass clears it.
//
// Fails open: a policy-layer error never hides an adult's podcasts.

import { podcastPolicyFor } from '@/lib/media/policyTier'
import { getClassifications, ensureClassifications, classificationBlocks, classify } from '@/lib/media/classify'
import { logger } from '@/lib/logger'

const SOURCE = 'podcast'

export interface FilterableEpisode {
  id: string
  title: string
  description?: string | null
  explicit?: number | null       // 1=explicit, 0=clean, null=unknown
}

/** Filter a list of podcast episodes for a user under their profile's podcast policy. */
export async function filterEpisodesForUser<T extends FilterableEpisode>(userId: string, episodes: T[]): Promise<T[]> {
  try {
    if (!episodes.length) return episodes
    const policy = await podcastPolicyFor(userId)
    if (policy.tier === 'open' && policy.explicit === 'allow' && policy.unknown === 'allow') return episodes

    const verdicts = await getClassifications(SOURCE, episodes.map((e) => e.id))
    const unknownBlocks = policy.unknown === 'block'
    const pending: T[] = []
    const kept = episodes.filter((e) => {
      if (policy.explicit === 'block' && e.explicit === 1) return false
      const verdict = verdicts.get(e.id)
      if (!verdict) pending.push(e)
      // A source-declared clean episode (explicit===0) isn't hidden merely for being unclassified.
      const treatUnknownAsBlock = unknownBlocks && e.explicit !== 0
      return !classificationBlocks(policy.ceiling, verdict, treatUnknownAsBlock)
    })
    if (pending.length) {
      ensureClassifications(pending.map((e) => ({ source: SOURCE, id: e.id, title: e.title, description: e.description ?? null })))
    }
    if (kept.length < episodes.length) {
      logger.debug(`[podcast/policy] filtered ${episodes.length - kept.length}/${episodes.length} for user ${userId} (tier ${policy.tier})`)
    }
    return kept
  } catch (err) {
    logger.debug(`[podcast/policy] filterEpisodesForUser failed (kept all): ${String(err)}`)
    return episodes
  }
}

/** Storefront (directory browse/search) filter: drop explicit shows for a profile that
 *  blocks explicit. Show-level only (no per-episode classifier here — these are catalog
 *  cards, not playable episodes); the episode filters + stream gate cover playback. */
export async function filterDirectoryForUser<T extends { explicit?: number | null }>(userId: string, results: T[]): Promise<T[]> {
  try {
    if (!results.length) return results
    const policy = await podcastPolicyFor(userId)
    if (policy.explicit === 'allow') return results
    return results.filter((r) => r.explicit !== 1)
  } catch (err) {
    logger.debug(`[podcast/policy] filterDirectoryForUser failed (kept all): ${String(err)}`)
    return results
  }
}

/** Single-episode hard gate for the playback stream route. Classifies SYNCHRONOUSLY so the
 *  verdict is real rather than a pending "unknown". Returns true when ALLOWED. Fails open. */
export async function podcastEpisodeAllowed(userId: string, ep: FilterableEpisode): Promise<boolean> {
  try {
    const policy = await podcastPolicyFor(userId)
    if (policy.tier === 'open' && policy.explicit === 'allow') return true
    if (policy.explicit === 'block' && ep.explicit === 1) return false
    let verdict = (await getClassifications(SOURCE, [ep.id])).get(ep.id)
    if (!verdict) {
      verdict = (await classify({ source: SOURCE, id: ep.id, title: ep.title, description: ep.description ?? null })) ?? undefined
    }
    const treatUnknownAsBlock = policy.unknown === 'block' && ep.explicit !== 0
    return !classificationBlocks(policy.ceiling, verdict, treatUnknownAsBlock)
  } catch (err) {
    logger.debug(`[podcast/policy] podcastEpisodeAllowed failed (allowed): ${String(err)}`)
    return true
  }
}
