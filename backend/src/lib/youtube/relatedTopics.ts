// Related-search topics: an LLM reads a video's title + transcript and names the 2-4
// concrete things it is actually about (products, series, games, techniques...), each as
// a YouTube search query. The watch page turns each into its own "Related" shelf — unlike
// InnerTube's related rail (which is engagement-ranked and opaque), these are labeled by
// topic so "X-Force Haptics Kit for X-Arcade 2TV-XR" yields shelves for the haptics kit
// AND the cabinet, not just more videos from the same channel.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { ytVideos } from '@/db/schema'
import { getTranscriptText } from '@/lib/youtube/transcript'
import { ollamaChat } from '@/llm/ollama'
import { getExtractionModel } from '@/lib/models'
import { logger } from '@/lib/logger'

// Two calls, not one, on the extraction model (stock instruct — see getExtractionModel):
// small models don't reliably keep the primary subject first when it's one clause of a
// bigger extraction prompt (confirmed live: granite 3b kept leading with "Arcade Ranger
// setup" for a video ABOUT the X-Arcade Arcade2TV-XR cabinet, no matter how the ordering
// instruction was phrased). The first call names the primary subject and the second adds
// the other subjects — first-place ordering holds by construction, not by instruction.
// Runs once per video (cached on yt_videos), so the bigger model is affordable.
const PRIMARY_SYSTEM =
  'You read a YouTube video\'s title (and transcript excerpt, when given) and name the ONE ' +
  'primary subject the video is centered on: the specific named product, hardware, game, ' +
  'series, person, or thing being set up, reviewed, demonstrated, or discussed — not an ' +
  'activity performed on it and not an accessory to it. The title names it more reliably ' +
  'than the transcript (speakers rarely say full product names aloud); when the title ' +
  'contains a specific product or model name, use it. Phrase it as a short YouTube search ' +
  'query. Example: for "X-Force Haptics Kit for X-Arcade 2TV-XR Will Blow Your Mind!" answer ' +
  'X-Arcade 2TV-XR arcade cabinet. Respond with ONLY the query — no prose, no quotes.'

const othersSystem = (primary: string) =>
  'You read a YouTube video\'s title (and transcript, when given). Its primary subject is ' +
  `already known: "${primary}". Extract 1-3 OTHER distinct concrete subjects the video ` +
  'covers — a product or accessory used in it, the platform it runs on, the technique shown, ' +
  'the people or events discussed — each phrased as a short YouTube search query someone ' +
  'would type to find more videos about that subject. Anchor each on a proper noun from the ' +
  'video when one exists; avoid generic phrasings (like "controller setup" or "headset ' +
  'compatibility") that would match videos about unrelated products, and never output two ' +
  'queries that differ only by a model number or variant — merge them into one. Never repeat ' +
  'or rephrase the primary subject, never include the channel name, and never invent ' +
  'subjects the video does not cover. Respond with ONLY a JSON array of 1-3 strings — no ' +
  'prose, no code fences, no keys.'

/** Normalize one model-produced query; null for degenerate output (empty, one-word noise,
 *  or an essay instead of a query). */
function cleanQuery(t: unknown): string | null {
  if (typeof t !== 'string') return null
  const q = t.trim().replace(/^["'`]+|["'`.]+$/g, '').replace(/\s+/g, ' ')
  return q.length >= 3 && q.length <= 80 ? q : null
}

/** Pull the first JSON string array out of a model reply, tolerating fences/prose around it. */
function parseTopicArray(raw: string): string[] {
  const match = raw.match(/\[[\s\S]*?\]/)
  if (!match) return []
  try {
    const arr = JSON.parse(match[0]) as unknown
    if (!Array.isArray(arr)) return []
    const seen = new Set<string>()
    const topics: string[] = []
    for (const t of arr) {
      const q = cleanQuery(t)
      if (!q) continue
      const key = q.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      topics.push(q)
      if (topics.length === 4) break
    }
    return topics
  } catch { return [] }
}

// Coalesce concurrent requests (watch-page open can race its own refetch) into one generation.
const _inFlight = new Map<string, Promise<string[]>>()

/**
 * Return the cached related-search topics for a video, generating + caching them from its
 * title + transcript if absent. Returns [] when there's nothing to extract from (no title
 * and no captions) or the model output is unusable — cached too, so a dud isn't retried
 * on every page open.
 */
export function ensureRelatedTopics(videoId: string, userId: string, firstName: string): Promise<string[]> {
  const existing = _inFlight.get(videoId)
  if (existing) return existing
  const p = generateRelatedTopics(videoId, userId, firstName)
  _inFlight.set(videoId, p)
  return p.finally(() => _inFlight.delete(videoId))
}

async function generateRelatedTopics(videoId: string, userId: string, firstName: string): Promise<string[]> {
  const [video] = await db.select().from(ytVideos).where(eq(ytVideos.videoId, videoId)).limit(1)
  if (video?.relatedTopics) {
    try { return JSON.parse(video.relatedTopics) as string[] } catch { /* regenerate */ }
  }

  // Title is the strongest signal (it names the subjects); the transcript disambiguates
  // and surfaces subjects the title doesn't mention. A title alone is still workable.
  const title = video?.title && video.title !== videoId ? video.title : null
  const transcript = (await getTranscriptText(videoId, userId, firstName).catch(() => null))?.slice(0, 8_000)
  if (!title && !transcript) return []

  logger.info({ videoId }, 'yt related topics: generating')
  const model = await getExtractionModel()
  const context = (excerptChars: number) => [
    title ? `Title: ${title}` : null,
    transcript ? `Transcript:\n${transcript.slice(0, excerptChars)}` : null,
  ].filter(Boolean).join('\n\n')

  // A short excerpt is enough to name the primary subject (and a full transcript actively
  // hurts: the model starts echoing whatever's said most often instead of the title).
  const primaryResult = await ollamaChat(model, [
    { role: 'system', content: PRIMARY_SYSTEM },
    { role: 'user', content: context(2_500) },
  ], undefined, { temperature: 0.2, num_predict: 60 })
  const primary = cleanQuery(primaryResult.message.content.split('\n')[0])

  const othersResult = await ollamaChat(model, [
    { role: 'system', content: othersSystem(primary ?? title ?? '') },
    { role: 'user', content: context(8_000) },
  ], undefined, { temperature: 0.2, num_predict: 200 })
  // Drop "others" that merely restate the primary subject with a couple of filler words
  // (e.g. "X-Arcade 2TV-XR" vs "X-Arcade 2TV-XR arcade cabinet") — but keep ones that add
  // a genuinely different angle even when they contain the primary's name. Also drop the
  // channel name: models keep offering it despite the instruction, and "more from this
  // channel" is the subscription feed's job, not a related-topic shelf's.
  const isRestatement = (a: string, b: string) => {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a]
    if (!long.includes(short)) return false
    return long.replace(short, ' ').trim().split(/\s+/).filter(Boolean).length <= 2
  }
  const pl = primary?.toLowerCase()
  const author = video?.author?.trim().toLowerCase()
  const others = parseTopicArray(othersResult.message.content)
    .filter((t) => !pl || !isRestatement(t.toLowerCase(), pl))
    .filter((t) => !author || !isRestatement(t.toLowerCase(), author))
  const topics = [...(primary ? [primary] : []), ...others].slice(0, 4)

  // Cache even an empty result — a video the model can't extract topics from won't get
  // better on the next open, and each retry costs a transcript fetch + LLM call.
  await db.insert(ytVideos)
    .values({ id: crypto.randomUUID(), videoId, title: video?.title || videoId, relatedTopics: JSON.stringify(topics), createdAt: new Date() })
    .onConflictDoUpdate({ target: ytVideos.videoId, set: { relatedTopics: JSON.stringify(topics) } })
  logger.info({ videoId, topics }, 'yt related topics: cached')
  return topics
}
