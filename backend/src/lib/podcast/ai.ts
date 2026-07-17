// AI over an episode transcript: a pre-listen summary + takeaways, auto-chapters for
// episodes the feed gave none, and the LLM titling behind snips. Chapters are written
// through lib/podcast/chapters.ts so the EXISTING chapters endpoint/UI serves them
// unchanged; only the "these were AI-made" flag lives in podcast_episode_ai.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { podcastEpisodeAi, podcastEpisodes, podcastTranscripts } from '@/db/schema'
import { getScriptModel } from '@/lib/models'
import { structuredCall } from '@/llm/structured'
import { cleanAutoText, cleanAutoTitle } from '@/lib/cleanTitle'
import { getEpisodeChapters, saveEpisodeChapters } from '@/lib/podcast/chapters'
import { fmtStamp, resolveEpisodeTranscript, type TranscriptSegment } from '@/lib/podcast/transcripts'
import type { EpisodeChapter } from '@/lib/podcast/types'
import { logger } from '@/lib/logger'

// Context budget for one insights pass. Long episodes get an evenly-sampled digest
// rather than a truncated first act, so chapters still span the whole runtime.
const MAX_CONTEXT_CHARS = 24_000
const MIN_CHAPTER_GAP_SEC = 45

export interface EpisodeInsights {
  summary: string | null
  takeaways: string[]
  chaptersGenerated: boolean
  model: string | null
}

function parseTakeaways(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.map(t => String(t)).filter(Boolean) : []
  } catch {
    return []
  }
}

/** A timestamped digest of the transcript that fits the context budget. Short episodes
 *  pass through verbatim; long ones are sampled evenly across the whole runtime. */
export function buildTimedDigest(segments: TranscriptSegment[], budget = MAX_CONTEXT_CHARS): string {
  const line = (s: TranscriptSegment) => `[${fmtStamp(s.startSec)}] ${s.text}`
  const full = segments.map(line).join('\n')
  if (full.length <= budget) return full

  // Evenly-spaced sampling keeps the timeline shape (needed for chapter starts).
  const stride = Math.ceil(full.length / budget)
  const picked: string[] = []
  let used = 0
  for (let i = 0; i < segments.length; i += stride) {
    const l = line(segments[i]!)
    if (used + l.length + 1 > budget) break
    picked.push(l)
    used += l.length + 1
  }
  return picked.join('\n')
}

const INSIGHTS_SYSTEM =
  'You summarize a podcast episode from its timestamped transcript for a listener deciding whether to play it. ' +
  'Return JSON with exactly these keys: "summary" (2 to 3 sentences, roughly 40 to 70 words, describing what the ' +
  'episode actually covers, written in plain natural English), "takeaways" (an array of 3 to 5 short strings, each ' +
  'one concrete point or claim from the episode, no more than 18 words each), and "chapters" (an array of objects ' +
  '{"title": string, "startSec": number} marking where each distinct topic begins, between 3 and 12 of them, ' +
  'titles under 60 characters, startSec taken from the [H:MM:SS] stamps in the transcript and converted to whole ' +
  'seconds, strictly increasing, the first one at or near 0). ' +
  'Never invent content that is not in the transcript. Do not use em dashes, emojis, hashtags, or markdown. ' +
  'Do not start the summary with "This episode" or "In this episode".'

interface InsightsResponse {
  summary?: unknown
  takeaways?: unknown
  chapters?: unknown
}

/** Normalize the model's chapter list: numeric starts, sorted, deduped, clamped to the
 *  episode's runtime, and thinned so two chapters never land on top of each other. */
function normalizeChapters(raw: unknown, durationSec: number | null): EpisodeChapter[] {
  if (!Array.isArray(raw)) return []
  const out: EpisodeChapter[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const startSec = Math.round(Number(o.startSec ?? o.start ?? o.startTime))
    const title = cleanAutoTitle(String(o.title ?? '')).slice(0, 200)
    if (!title || !Number.isFinite(startSec) || startSec < 0) continue
    if (durationSec && startSec > durationSec) continue
    out.push({ title, startSec })
  }
  out.sort((a, b) => a.startSec - b.startSec)
  const thinned: EpisodeChapter[] = []
  for (const c of out) {
    const prev = thinned[thinned.length - 1]
    if (prev && c.startSec - prev.startSec < MIN_CHAPTER_GAP_SEC) continue
    thinned.push(c)
  }
  return thinned.slice(0, 40)
}

/** Read cached insights for an episode (no generation). */
export async function getEpisodeInsights(episodeId: string): Promise<EpisodeInsights | null> {
  const [row] = await db.select().from(podcastEpisodeAi).where(eq(podcastEpisodeAi.episodeId, episodeId))
  if (!row) return null
  return {
    summary: row.summary,
    takeaways: parseTakeaways(row.takeawaysJson),
    chaptersGenerated: row.chaptersGenerated,
    model: row.model,
  }
}

/**
 * Generate (and cache) the summary + takeaways for an episode, and auto-chapters when
 * the episode has none from any other source. Requires a ready transcript; throws with
 * a user-facing message otherwise. `force` regenerates over an existing cache.
 */
export async function generateEpisodeInsights(episodeId: string, opts: { force?: boolean } = {}): Promise<EpisodeInsights> {
  if (!opts.force) {
    const cached = await getEpisodeInsights(episodeId)
    if (cached?.summary) return cached
  }

  const transcript = await resolveEpisodeTranscript(episodeId)
  if (!transcript || transcript.status !== 'ready' || !transcript.segments.length) {
    throw new Error('This episode has no transcript yet')
  }
  const [episode] = await db.select({ title: podcastEpisodes.title, durationSec: podcastEpisodes.durationSec })
    .from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId))
  if (!episode) throw new Error('Unknown episode')

  // Only ask for chapters when the episode genuinely has none (feed-provided or
  // generated-at-build-time chapters always win).
  const existingChapters = await getEpisodeChapters(episodeId)
  const wantChapters = existingChapters.length === 0

  const digest = buildTimedDigest(transcript.segments)
  const prompt = [
    `Episode title: ${episode.title}`,
    episode.durationSec ? `Runtime: ${fmtStamp(episode.durationSec)}` : '',
    wantChapters ? '' : 'This episode already has chapters: return an empty "chapters" array.',
    '',
    'Transcript (each line is prefixed with its start time):',
    digest,
  ].filter(Boolean).join('\n')

  const model = await getScriptModel()
  const res = await structuredCall<InsightsResponse>(model, prompt, INSIGHTS_SYSTEM, { num_predict: 1400 })

  const summary = cleanAutoText(String(res.summary ?? '').trim()).slice(0, 1200) || null
  const takeaways = (Array.isArray(res.takeaways) ? res.takeaways : [])
    .map(t => cleanAutoText(String(t ?? '').trim()))
    .filter(Boolean)
    .slice(0, 5)
  if (!summary && !takeaways.length) throw new Error('The model returned no usable summary')

  let chaptersGenerated = false
  if (wantChapters) {
    const chapters = normalizeChapters(res.chapters, episode.durationSec)
    if (chapters.length >= 2) {
      await saveEpisodeChapters(episodeId, chapters)
      chaptersGenerated = true
    }
  }

  const now = new Date()
  await db.insert(podcastEpisodeAi).values({
    id: crypto.randomUUID(),
    episodeId,
    summary,
    takeawaysJson: JSON.stringify(takeaways),
    chaptersGenerated,
    model,
    createdAt: now,
  }).onConflictDoUpdate({
    target: [podcastEpisodeAi.episodeId],
    set: { summary, takeawaysJson: JSON.stringify(takeaways), chaptersGenerated, model },
  })

  logger.info(`[podcast-ai] insights for "${episode.title}"${chaptersGenerated ? ' (+auto chapters)' : ''}`)
  return { summary, takeaways, chaptersGenerated, model }
}

// ── Snips ─────────────────────────────────────────────────────────────────────────

const SNIP_SYSTEM =
  'You title and summarize a short clip from a podcast, taken from its transcript. Return JSON with exactly ' +
  'these keys: "title" (under 60 characters, specific to what is actually said in the clip, no quotes around it) ' +
  'and "summary" (1 to 2 sentences, under 45 words, capturing the point of the clip). ' +
  'Never invent content beyond the clip. No em dashes, emojis, hashtags, or markdown.'

/** LLM title + summary for a clipped transcript window. Falls back to a positional
 *  title so "Clip that" always saves something, even with the model unavailable. */
export async function titleSnip(episodeTitle: string, startSec: number, text: string): Promise<{ title: string; summary: string | null }> {
  const fallback = { title: `${episodeTitle} at ${fmtStamp(startSec)}`.slice(0, 120), summary: null as string | null }
  if (!text.trim()) return fallback
  try {
    const model = await getScriptModel()
    const res = await structuredCall<{ title?: unknown; summary?: unknown }>(
      model,
      `Podcast episode: ${episodeTitle}\nClip starts at ${fmtStamp(startSec)}.\n\nClip transcript:\n${text.slice(0, 6000)}`,
      SNIP_SYSTEM,
      { num_predict: 300 },
    )
    const title = cleanAutoTitle(String(res.title ?? '').trim()).slice(0, 120)
    const summary = cleanAutoText(String(res.summary ?? '').trim()).slice(0, 600) || null
    return title ? { title, summary } : { ...fallback, summary }
  } catch (err) {
    logger.warn(`[podcast-ai] snip titling failed: ${err}`)
    return fallback
  }
}

// ── Ask the episode ───────────────────────────────────────────────────────────────

/** Build the grounded context for one question about an episode. Short transcripts go
 *  in whole; long ones retrieve the most relevant windows from the FTS index first
 *  (falling back to an evenly-sampled digest when the query matches nothing). */
export async function buildAskContext(episodeId: string, question: string, segments: TranscriptSegment[]): Promise<string> {
  const full = buildTimedDigest(segments, MAX_CONTEXT_CHARS)
  const verbatim = segments.map(s => `[${fmtStamp(s.startSec)}] ${s.text}`).join('\n')
  if (verbatim.length <= MAX_CONTEXT_CHARS) return verbatim

  const { searchTranscriptWindows } = await import('@/lib/podcast/transcripts')
  const hits = searchTranscriptWindows(question, 24, episodeId)
  if (!hits.length) return full

  // Retrieved windows, replayed in chronological order so the model reads the episode
  // forwards rather than in relevance order.
  const ordered = [...hits].sort((a, b) => a.startSec - b.startSec)
  const lines: string[] = []
  let used = 0
  for (const h of ordered) {
    const l = `[${fmtStamp(h.startSec)}] ${h.text}`
    if (used + l.length + 1 > MAX_CONTEXT_CHARS) break
    lines.push(l)
    used += l.length + 1
  }
  return lines.join('\n')
}

/** True when this episode has a ready transcript row (cheap check, no fetch). */
export async function hasReadyTranscript(episodeId: string): Promise<boolean> {
  const [row] = await db.select({ status: podcastTranscripts.status }).from(podcastTranscripts)
    .where(eq(podcastTranscripts.episodeId, episodeId))
  return row?.status === 'ready'
}
