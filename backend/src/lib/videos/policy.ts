// Content-policy bridge for video sources. Two layers:
//   • adult flags — source-native signals (reddit over_18/nsfw subreddits, vimeo nudity,
//     youtube age-gate) only shown when the profile permits sexual content at all.
//   • topical classifier — the profile's full dial ceiling, applied to what a card is ABOUT
//     (drugs/violence/etc.), catching mature content the platform never flagged. On a kid
//     tier, items with no clean signal yet are hidden until the background classifier clears
//     them; the classifier is warmed as a side effect so the picture sharpens with use.
//
// filterVideosForUser is the single chokepoint every hub + YouTube list route passes through.
// Fails open: a policy-layer error never hides an adult's feed.

import { getUserCeiling } from '@/lib/contentPolicy'
import { videoPolicyFor } from '@/lib/media/policyTier'
import { getClassifications, ensureClassifications, classificationBlocks, classify } from '@/lib/media/classify'
import { logger } from '@/lib/logger'
import type { VideoItem } from '@/lib/videos/types'

/** True when this user's content profile permits adult-flagged video content. */
export async function allowAdultVideos(userId: string): Promise<boolean> {
  const dials = await getUserCeiling(userId)
  return dials.sexual !== 'off'
}

// A card's description, wherever a provider stashed it: top-level (getItem results carry it)
// or provider extras in `meta`. Feeds the topical classifier; missing → just title+channel.
function descriptionOf(it: VideoItem): string | null {
  const top = (it as { description?: unknown }).description
  if (typeof top === 'string' && top) return top
  if (typeof it.meta?.description === 'string') return it.meta.description as string
  return null
}

/** Filter a list of video items for a user under their profile's video policy. */
export async function filterVideosForUser(userId: string, items: VideoItem[]): Promise<VideoItem[]> {
  try {
    if (!items.length) return items
    const policy = await videoPolicyFor(userId)
    // Open tier: no filtering at all (the common adult case — one cheap policy read, no LLM).
    if (policy.adult === 'allow' && policy.unknown === 'allow' && policy.tier === 'open') return items

    // Adult-flag pass (also treats a source's explicit familySafe===false as adult).
    let kept = items.filter((it) => {
      const flaggedAdult = it.isAdult === true || it.familySafe === false
      return policy.adult === 'allow' || !flaggedAdult
    })

    // Topical-classifier pass, grouped by source so the cache key (source,id) is correct.
    const unknownBlocks = policy.unknown === 'block'
    const bySource = new Map<string, VideoItem[]>()
    for (const it of kept) {
      const arr = bySource.get(it.source) ?? []
      arr.push(it); bySource.set(it.source, arr)
    }
    const blocked = new Set<string>()      // `${source}:${id}`
    for (const [source, arr] of bySource) {
      const verdicts = await getClassifications(source, arr.map((a) => a.id))
      const pending: typeof arr = []
      for (const it of arr) {
        const verdict = verdicts.get(it.id)
        // A source-vouched family-safe item still gets a topical check if we already have a
        // verdict, but is NOT hidden merely for being unclassified.
        const treatUnknownAsBlock = unknownBlocks && it.familySafe !== true
        if (classificationBlocks(policy.ceiling, verdict, treatUnknownAsBlock)) {
          blocked.add(`${source}:${it.id}`)
        }
        if (!verdict) pending.push(it)
      }
      // Warm classifications for anything unrated (title/description/channel are cheap to pass).
      if (pending.length) {
        ensureClassifications(pending.map((it) => ({
          source, id: it.id, title: it.title,
          description: descriptionOf(it),
          channel: it.creator?.name ?? null,
        })))
      }
    }
    kept = kept.filter((it) => !blocked.has(`${it.source}:${it.id}`))
    if (kept.length < items.length) {
      logger.debug(`[videos/policy] filtered ${items.length - kept.length}/${items.length} for user ${userId} (tier ${policy.tier})`)
    }
    return kept
  } catch (err) {
    logger.debug(`[videos/policy] filterVideosForUser failed (kept all): ${String(err)}`)
    return items
  }
}

/** Adapter for the standalone /api/youtube/* routes, whose lists are ItVideo-shaped
 *  (videoId/title/author/channelId), not VideoItem. Maps to the shared filter and returns the
 *  kept originals, preserving the native response shape. */
export async function filterYtItemsForUser<T extends { videoId: string; title: string; author: string | null; channelId?: string | null }>(
  userId: string, vids: T[],
): Promise<T[]> {
  if (!vids.length) return vids
  const asItems: VideoItem[] = vids.map((v) => ({
    source: 'youtube', id: v.videoId, url: `https://www.youtube.com/watch?v=${v.videoId}`,
    title: v.title,
    creator: v.channelId ? { id: v.channelId, name: v.author ?? '' } : v.author ? { id: '', name: v.author } : null,
  }))
  const kept = await filterVideosForUser(userId, asItems)
  const keepIds = new Set(kept.map((i) => i.id))
  return vids.filter((v) => keepIds.has(v.videoId))
}

/** Single-item gate for the playback/detail routes — the hard guarantee that a direct link
 *  can't play a blocked video for a kid profile even if a card leaked through. Unlike the list
 *  filter, this classifies SYNCHRONOUSLY so the verdict is real (the watch path tolerates the
 *  ~1s) rather than a pending "unknown". Returns true when the item is ALLOWED. Fails open. */
export async function videoAllowedForUser(userId: string, item: VideoItem): Promise<boolean> {
  try {
    const policy = await videoPolicyFor(userId)
    if (policy.tier === 'open' && policy.adult === 'allow') return true
    const flaggedAdult = item.isAdult === true || item.familySafe === false
    if (policy.adult === 'block' && flaggedAdult) return false
    let verdict = (await getClassifications(item.source, [item.id])).get(item.id)
    if (!verdict) {
      verdict = (await classify({
        source: item.source, id: item.id, title: item.title,
        description: descriptionOf(item), channel: item.creator?.name ?? null,
      })) ?? undefined
    }
    const treatUnknownAsBlock = policy.unknown === 'block' && item.familySafe !== true
    return !classificationBlocks(policy.ceiling, verdict, treatUnknownAsBlock)
  } catch (err) {
    logger.debug(`[videos/policy] videoAllowedForUser failed (allowed): ${String(err)}`)
    return true
  }
}
