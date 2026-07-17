// Extra grounding for Ask-the-video, beyond the transcript: who/what the channel is, and
// what viewers are saying. Both are cached (channel bios rarely change; comments change
// slowly enough that a short TTL is fine) so asking several questions about the same
// video only pays the fetch cost once.

import { getProvider } from '@/lib/videos/registry'
import { cachedLookup } from '@/lib/lookupCache'
import { webSearch } from '@/lib/webSearch'
import { logger } from '@/lib/logger'

const ABOUT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const COMMENTS_TTL_MS = 60 * 60 * 1000
const MIN_ABOUT_LEN = 40
const MAX_ABOUT_LEN = 800
const MAX_COMMENTS = 10
const MAX_COMMENT_LEN = 300

/** "Who/what is this channel/creator" — the channel's own About text when it says enough,
 *  else a couple of web-search snippets on the creator's name. Every provider exposes
 *  `description` on `getCreator()` uniformly, so this needs no per-source branching. */
export async function getVideoAboutBlurb(
  source: string, creatorId: string | null, creatorName: string | null,
): Promise<string | null> {
  if (!creatorId && !creatorName) return null
  const key = `${source}:${creatorId ?? creatorName}`
  return cachedLookup('video-ask-about', key, ABOUT_TTL_MS, async () => {
    const provider = getProvider(source)
    if (creatorId && provider?.getCreator) {
      try {
        const { creator } = await provider.getCreator(creatorId)
        const desc = creator.description?.trim()
        if (desc && desc.length >= MIN_ABOUT_LEN) return desc.slice(0, MAX_ABOUT_LEN)
      } catch (err) {
        logger.debug(`[videos/ask] getCreator failed for ${source}:${creatorId}: ${String(err)}`)
      }
    }
    if (!creatorName) return null
    try {
      const results = await webSearch(`${creatorName} ${source === 'youtube' ? 'youtube channel' : source}`, 3)
      const snippets = results.map((r) => r.snippet).filter(Boolean)
      return snippets.length ? snippets.join(' ').slice(0, MAX_ABOUT_LEN) : null
    } catch (err) {
      logger.debug(`[videos/ask] web search fallback failed for "${creatorName}": ${String(err)}`)
      return null
    }
  })
}

export interface AskComment { author: string; text: string }

/** A handful of top comments, for questions the transcript alone can't answer ("what's
 *  special about this?", "who is this?") — often exactly where viewers say it in the
 *  comments. Absent on sources with no comments API (TikTok): resolves to []. */
export async function getVideoTopComments(source: string, videoId: string): Promise<AskComment[]> {
  const key = `${source}:${videoId}`
  return cachedLookup('video-ask-comments', key, COMMENTS_TTL_MS, async () => {
    const provider = getProvider(source)
    if (!provider?.getComments) return []
    try {
      const comments = await provider.getComments(videoId)
      return comments
        .filter((c) => c.text?.trim())
        .slice(0, MAX_COMMENTS)
        .map((c) => ({ author: c.author || 'Someone', text: c.text.trim().slice(0, MAX_COMMENT_LEN) }))
    } catch (err) {
      logger.debug(`[videos/ask] getComments failed for ${source}:${videoId}: ${String(err)}`)
      return []
    }
  })
}
