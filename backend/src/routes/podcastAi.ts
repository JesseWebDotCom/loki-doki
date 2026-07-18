// AI-native podcast listening: episode transcripts (feed-provided or Whisper-made),
// AI summary + auto-chapters, snips, ask-the-episode, and library-wide transcript
// search. Mounted beside the other podcast routers under /api/podcasts (distinct
// sub-paths, no collisions).

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import {
  downloadJobs, podcastAdReports, podcastEpisodes, podcastMoments, podcastShows, podcastSubscriptions, podcastTranscripts, users,
} from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import { ollamaChatStream } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { filterEpisodesForUser, podcastEpisodeAllowed } from '@/lib/podcast/policy'
import { familyEntrySetsFor, podcastShowAllowed } from '@/lib/family/audioPolicy'
import { resolveEpisodeTranscript, searchTranscriptWindows } from '@/lib/podcast/transcripts'
import { enqueueEpisodeTranscription, transcribeJobRefId } from '@/lib/podcast/transcribe'
import { adScanJobRefId, enqueueAdScan, episodeHasLocalAudio, getAdSegments } from '@/lib/podcast/adScan'
import { buildAskContext, generateEpisodeInsights, getEpisodeInsights } from '@/lib/podcast/ai'
import { createSnip, deleteSnip, listSnips } from '@/lib/podcast/snips'
import { logger } from '@/lib/logger'
import type { AppEnv } from '@/types'

export const podcastAiRoute = new Hono<AppEnv>()
podcastAiRoute.use('*', requireAuth)

// ── Access control (same semantics as routes/podcasts.ts) ─────────────────────────
type Actor = { id: string; role: string }
type ShowAccess = { ownerUserId: string; visibility: string | null; source?: string | null }
const canSeeShow = (s: ShowAccess, u: Actor) =>
  s.ownerUserId === u.id || s.visibility === 'shared' || s.source === 'rss' || u.role === 'admin'

/** Resolve an episode a user is allowed to see, or null. Every route here goes through
 *  this rather than trusting a bare episode id. */
async function visibleEpisode(episodeId: string, user: Actor) {
  const [row] = await db.select({
    id: podcastEpisodes.id,
    title: podcastEpisodes.title,
    description: podcastEpisodes.description,
    explicit: podcastEpisodes.explicit,
    durationSec: podcastEpisodes.durationSec,
    showId: podcastShows.id,
    showName: podcastShows.name,
    showFeedUrl: podcastShows.feedUrl,
    ownerUserId: podcastShows.ownerUserId,
    visibility: podcastShows.visibility,
    source: podcastShows.source,
  }).from(podcastEpisodes)
    .innerJoin(podcastShows, eq(podcastEpisodes.showId, podcastShows.id))
    .where(eq(podcastEpisodes.id, episodeId))
  if (!row || !canSeeShow(row, user)) return null
  // Kid-safe media: an episode filtered out of the lists must not be readable by id.
  if (!(await podcastEpisodeAllowed(user.id, { id: row.id, title: row.title, description: row.description, explicit: row.explicit }))) {
    return null
  }
  const sets = await familyEntrySetsFor(user.id)
  if (sets.hasAny && !podcastShowAllowed(sets, { id: row.showId, feedUrl: row.showFeedUrl })) return null
  return row
}

// ── Transcript ────────────────────────────────────────────────────────────────────

/** The transcript panel's one read: cached segments, a lazy fetch of the feed's
 *  transcript document, or the state of an in-flight Whisper job. Never transcribes
 *  inline (that is a background job) so this always answers fast. */
podcastAiRoute.get('/episodes/:id/transcript', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  const episode = await visibleEpisode(episodeId, user)
  if (!episode) return c.json({ error: 'Not found' }, 404)

  const transcript = await resolveEpisodeTranscript(episodeId)
  if (!transcript) {
    return c.json({ transcript: null, status: 'none', canTranscribe: true, progress: null })
  }
  // Surface the job's progress note while Whisper is running.
  let progress: { note: string | null; percent: number | null } | null = null
  if (transcript.status === 'pending' || transcript.status === 'processing') {
    const [job] = await db.select({ progress: downloadJobs.progress, status: downloadJobs.status })
      .from(downloadJobs)
      .where(and(eq(downloadJobs.type, 'podcast-transcribe'), eq(downloadJobs.refId, transcribeJobRefId(episodeId))))
      .limit(1)
    if (job?.progress) {
      try {
        const p = JSON.parse(job.progress) as { completed?: number; total?: number; note?: string }
        const percent = p.total && p.total > 0 ? Math.min(99, Math.round(((p.completed ?? 0) / p.total) * 100)) : null
        progress = { note: p.note ?? null, percent }
      } catch { progress = null }
    }
  }
  return c.json({
    transcript: transcript.status === 'ready' ? { segments: transcript.segments, source: transcript.source, format: transcript.format } : null,
    status: transcript.status,
    error: transcript.error,
    canTranscribe: transcript.status === 'failed',
    progress,
  })
})

/** Queue a Whisper transcription. Returns immediately; the panel polls the GET above. */
podcastAiRoute.post('/episodes/:id/transcribe', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  const episode = await visibleEpisode(episodeId, user)
  if (!episode) return c.json({ error: 'Not found' }, 404)
  try {
    await enqueueEpisodeTranscription(episodeId, user.id)
    return c.json({ ok: true, status: 'pending' })
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 400)
  }
})

/** In-episode transcript search: the FTS index scoped to one episode, so a long
 *  transcript does not have to be scanned in the browser. */
podcastAiRoute.get('/episodes/:id/transcript/search', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  const q = c.req.query('q')?.trim() ?? ''
  const episode = await visibleEpisode(episodeId, user)
  if (!episode) return c.json({ error: 'Not found' }, 404)
  if (!q) return c.json({ hits: [] })
  const hits = searchTranscriptWindows(q, 40, episodeId)
  return c.json({ hits: hits.map(h => ({ startSec: h.startSec, endSec: h.endSec, snippet: h.snippet, text: h.text })) })
})

// ── Ad detection ──────────────────────────────────────────────────────────────────

/** The player's one read: detected ad ranges with household 'not_ad' corrections
 *  already applied. status 'none' means no scan has ever been requested. While a scan
 *  is in flight, surfaces its job progress (percent + note) so the player can show it. */
podcastAiRoute.get('/episodes/:id/ad-segments', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  const episode = await visibleEpisode(episodeId, user)
  if (!episode) return c.json({ error: 'Not found' }, 404)
  const result = await getAdSegments(episodeId)
  const audioLocal = await episodeHasLocalAudio(episodeId)
  let progress: { note: string | null; percent: number | null } | null = null
  if (result.status === 'pending' || result.status === 'processing') {
    const [job] = await db.select({ progress: downloadJobs.progress }).from(downloadJobs)
      .where(and(eq(downloadJobs.type, 'podcast-ad-scan'), eq(downloadJobs.refId, adScanJobRefId(episodeId))))
      .limit(1)
    if (job?.progress) {
      try {
        const p = JSON.parse(job.progress) as { completed?: number; total?: number; note?: string }
        const percent = p.total && p.total > 0 ? Math.min(99, Math.round(((p.completed ?? 0) / p.total) * 100)) : null
        progress = { note: p.note ?? null, percent }
      } catch { progress = null }
    }
  }
  return c.json({ ...result, audioLocal, progress })
})

/** Queue an ad scan. Returns immediately; the player polls the GET above. Requires a
 *  ready transcript (400 with a user-facing message otherwise). */
podcastAiRoute.post('/episodes/:id/ad-scan', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  const episode = await visibleEpisode(episodeId, user)
  if (!episode) return c.json({ error: 'Not found' }, 404)
  const force = c.req.query('force') === '1'
  try {
    await enqueueAdScan(episodeId, user.id, { force })
    return c.json({ ok: true, status: 'pending' })
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 400)
  }
})

/** Corrections. 'not_ad' suppresses a detected range household-wide (matched by time
 *  overlap, so it survives rescans); 'missed' records a spot the scan missed and
 *  force-rescans the episode. */
podcastAiRoute.post('/episodes/:id/ad-reports', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  const episode = await visibleEpisode(episodeId, user)
  if (!episode) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<{ kind?: string; startSec?: number; endSec?: number; positionSec?: number }>()
    .catch(() => ({} as Record<string, never>))

  if (body.kind === 'not_ad') {
    const startSec = Math.max(0, Number(body.startSec) || 0)
    const endSec = Math.max(startSec, Number(body.endSec) || 0)
    if (endSec <= startSec) return c.json({ error: 'startSec and endSec required' }, 400)
    await db.insert(podcastAdReports).values({
      id: crypto.randomUUID(), userId: user.id, episodeId,
      kind: 'not_ad', startSec, endSec, createdAt: new Date(),
    })
    return c.json(await getAdSegments(episodeId))
  }

  if (body.kind === 'missed') {
    const positionSec = Math.max(0, Number(body.positionSec) || 0)
    await db.insert(podcastAdReports).values({
      id: crypto.randomUUID(), userId: user.id, episodeId,
      kind: 'missed', startSec: positionSec, endSec: 0, createdAt: new Date(),
    })
    // Best-effort: a rescan needs a transcript, and a missing one is not this
    // report's problem (the report row is already saved for a later scan).
    await enqueueAdScan(episodeId, user.id, { force: true }).catch(() => {})
    return c.json({ ok: true })
  }

  return c.json({ error: 'kind must be not_ad or missed' }, 400)
})

// ── AI summary + auto-chapters ────────────────────────────────────────────────────

podcastAiRoute.get('/episodes/:id/insights', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  const episode = await visibleEpisode(episodeId, user)
  if (!episode) return c.json({ error: 'Not found' }, 404)
  const insights = await getEpisodeInsights(episodeId)
  const [t] = await db.select({ status: podcastTranscripts.status }).from(podcastTranscripts)
    .where(eq(podcastTranscripts.episodeId, episodeId))
  return c.json({ insights, transcriptStatus: t?.status ?? 'none' })
})

podcastAiRoute.post('/episodes/:id/insights', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  const episode = await visibleEpisode(episodeId, user)
  if (!episode) return c.json({ error: 'Not found' }, 404)
  const force = c.req.query('force') === '1'
  try {
    return c.json({ insights: await generateEpisodeInsights(episodeId, { force }) })
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 400)
  }
})

// ── Snips ─────────────────────────────────────────────────────────────────────────

podcastAiRoute.get('/snips', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.query('episodeId')?.trim() || undefined
  return c.json({ snips: await listSnips(user.id, { episodeId }) })
})

podcastAiRoute.post('/snips', async (c) => {
  const user = c.get('user')
  const body = await c.req.json<{ episodeId?: string; positionSec?: number }>().catch(() => ({} as Record<string, never>))
  const episodeId = body.episodeId?.trim()
  if (!episodeId) return c.json({ error: 'episodeId required' }, 400)
  const positionSec = Math.max(0, Number(body.positionSec) || 0)
  const episode = await visibleEpisode(episodeId, user)
  if (!episode) return c.json({ error: 'Not found' }, 404)
  try {
    return c.json({ snip: await createSnip(user.id, episodeId, positionSec) })
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 400)
  }
})

podcastAiRoute.delete('/snips/:id', async (c) => {
  const user = c.get('user')
  const ok = await deleteSnip(user.id, c.req.param('id'))
  if (!ok) return c.json({ error: 'Not found' }, 404)
  return c.json({ ok: true })
})

// ── Moments ──────────────────────────────────────────────────────────────────────
// The household social layer for an episode (bookmark + emoji reaction at a timestamp)
// — mirrors video_moments/music_moments' three-route shape. Distinct from Snips: a
// Moment is a raw, freeform household reaction (no AI title/summary), same as Video's.
podcastAiRoute.get('/episodes/:id/moments', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  const episode = await visibleEpisode(episodeId, user)
  if (!episode) return c.json({ error: 'Not found' }, 404)
  const rows = await db.select({
    id: podcastMoments.id, userId: podcastMoments.userId, atSec: podcastMoments.atSec,
    emoji: podcastMoments.emoji, note: podcastMoments.note, createdAt: podcastMoments.createdAt,
    name: users.nickname, firstName: users.firstName,
  })
    .from(podcastMoments)
    .leftJoin(users, eq(users.id, podcastMoments.userId))
    .where(eq(podcastMoments.episodeId, episodeId))
    .orderBy(asc(podcastMoments.atSec))
  return c.json({
    moments: rows.map((r) => ({
      id: r.id, userId: r.userId, atSec: r.atSec, emoji: r.emoji, note: r.note,
      by: r.name || r.firstName || 'Someone',
      mine: r.userId === user.id,
      createdAt: r.createdAt?.getTime() ?? 0,
    })),
  })
})

podcastAiRoute.post('/episodes/:id/moments', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  const episode = await visibleEpisode(episodeId, user)
  if (!episode) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json().catch(() => ({})) as { atSec?: number; emoji?: string; note?: string }
  if (!Number.isFinite(body.atSec)) return c.json({ error: 'atSec required' }, 400)
  const emoji = body.emoji?.trim().slice(0, 8) || null
  const note = body.note?.trim().slice(0, 300) || null
  if (!emoji && !note) return c.json({ error: 'emoji or note required' }, 400)
  const id = crypto.randomUUID()
  await db.insert(podcastMoments).values({
    id, userId: user.id, episodeId,
    atSec: Math.max(0, Math.floor(body.atSec as number)), emoji, note, createdAt: new Date(),
  })
  return c.json({ id })
})

// Only the author may remove their own reaction.
podcastAiRoute.delete('/moments/:momentId', async (c) => {
  const user = c.get('user')
  await db.delete(podcastMoments).where(and(
    eq(podcastMoments.id, c.req.param('momentId')),
    eq(podcastMoments.userId, user.id),
  ))
  return c.json({ ok: true })
})

// ── Ask the episode ───────────────────────────────────────────────────────────────

// A lightweight per-episode chat grounded in the transcript. Session-only: the client
// holds the thread and replays it, so nothing is persisted server-side. Long
// transcripts retrieve the relevant windows from the FTS index first.
podcastAiRoute.post('/episodes/:id/ask', async (c) => {
  const user = c.get('user')
  const episodeId = c.req.param('id')
  const episode = await visibleEpisode(episodeId, user)
  if (!episode) return c.json({ error: 'Not found' }, 404)

  const body = await c.req.json<{ question?: string; history?: { role: 'user' | 'assistant'; content: string }[] }>()
    .catch(() => ({} as Record<string, never>))
  const question = body.question?.trim()
  if (!question) return c.json({ error: 'question required' }, 400)

  const transcript = await resolveEpisodeTranscript(episodeId)
  if (!transcript || transcript.status !== 'ready' || !transcript.segments.length) {
    return c.json({ error: 'This episode has no transcript yet' }, 400)
  }

  const context = await buildAskContext(episodeId, question, transcript.segments)
  const systemPrompt =
    `You answer questions about one podcast episode, using ONLY the transcript below. ` +
    `Episode: "${episode.title}" from the show "${episode.showName}".\n` +
    `Answer in plain natural English, briefly (a short paragraph unless more is genuinely needed). ` +
    `Cite the moment you are drawing on with its timestamp in [H:MM:SS] form when it helps the listener jump there. ` +
    `If the transcript does not cover the question, say so plainly instead of guessing. ` +
    `Do not use em dashes.\n\n` +
    `Transcript (each line is prefixed with its start time):\n${context}`

  // The client's replayed history is capped: this is a per-episode side thread, not a
  // full conversation store, and the transcript already dominates the context budget.
  const history = (body.history ?? [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-6)
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }))

  const model = await getModel()
  return streamSSE(c, async stream => {
    try {
      const chunks = ollamaChatStream(model, [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: question },
      ], { temperature: 0.3 })
      for await (const chunk of chunks) {
        if (chunk.message?.content) {
          await stream.writeSSE({ data: JSON.stringify({ token: chunk.message.content }) })
        }
      }
      await stream.writeSSE({ data: JSON.stringify({ done: true }) })
    } catch (err) {
      await stream.writeSSE({ data: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }) })
    }
  })
})

// ── Library-wide transcript search ────────────────────────────────────────────────

interface SearchResultEpisode {
  episodeId: string
  title: string
  showId: string
  showName: string
  durationSec: number | null
  publishedAt: Date | null
  hits: { startSec: number; endSec: number; snippet: string }[]
}

// How many bm25 candidates get the embedding pass. Each one is a separate nomic call,
// so this trades a little latency for recall on paraphrased queries.
const RERANK_LIMIT = 20

/** Re-order the top candidates by embedding similarity between the query and each
 *  episode's best matching window. Mutates `ranked` in place; returns whether it ran.
 *  Any failure (Ollama down, model not pulled) leaves the bm25 order untouched. */
async function rerankByEmbedding(query: string, ranked: SearchResultEpisode[]): Promise<boolean> {
  const head = ranked.slice(0, RERANK_LIMIT)
  if (head.length < 2) return false
  try {
    const { embed, cosineSimilarity } = await import('@/llm/embed')
    const qVec = await embed(query)
    const scored = await Promise.all(head.map(async (r) => {
      // The window texts are what actually matched; the title carries the topic.
      const text = `${r.title}. ${r.hits.map(h => h.snippet.replace(/[[\]]/g, '')).join(' ')}`.slice(0, 2000)
      const vec = await embed(text)
      return { r, score: cosineSimilarity(qVec, vec) }
    }))
    scored.sort((a, b) => b.score - a.score)
    for (let i = 0; i < scored.length; i++) ranked[i] = scored[i]!.r
    return true
  } catch (err) {
    logger.warn(`[podcast-search] embedding re-rank skipped: ${err}`)
    return false
  }
}

// "Search everything": FTS5 over every indexed transcript segment, grouped into
// episodes with their matched, timestamped snippets. Results are filtered to the
// shows this profile may see BEFORE anything is returned.
podcastAiRoute.get('/search/transcripts', async (c) => {
  const user = c.get('user')
  const q = c.req.query('q')?.trim() ?? ''
  if (!q) return c.json({ results: [] })

  // Over-fetch: the visibility filter below removes rows, and hits cluster per episode.
  const raw = searchTranscriptWindows(q, 200)
  if (!raw.length) return c.json({ results: [] })

  const episodeIds = [...new Set(raw.map(h => h.episodeId))]
  const rows = await db.select({
    id: podcastEpisodes.id,
    title: podcastEpisodes.title,
    description: podcastEpisodes.description,
    explicit: podcastEpisodes.explicit,
    durationSec: podcastEpisodes.durationSec,
    publishedAt: podcastEpisodes.publishedAt,
    createdAt: podcastEpisodes.createdAt,
    showId: podcastShows.id,
    showName: podcastShows.name,
    showFeedUrl: podcastShows.feedUrl,
    ownerUserId: podcastShows.ownerUserId,
    visibility: podcastShows.visibility,
    source: podcastShows.source,
  }).from(podcastEpisodes)
    .innerJoin(podcastShows, eq(podcastEpisodes.showId, podcastShows.id))
    .where(inArray(podcastEpisodes.id, episodeIds))

  // Subscribed RSS shows only enter this user's library once they subscribe; an
  // unsubscribed household show should not surface in their search.
  const subs = await db.select({ showId: podcastSubscriptions.showId }).from(podcastSubscriptions)
    .where(eq(podcastSubscriptions.userId, user.id))
  const subscribed = new Set(subs.map(s => s.showId))
  const sets = await familyEntrySetsFor(user.id)

  const allowedRows = rows.filter(r =>
    canSeeShow(r, user)
    && (r.source !== 'rss' || subscribed.has(r.showId))
    && (!sets.hasAny || podcastShowAllowed(sets, { id: r.showId, feedUrl: r.showFeedUrl })))
  const safeRows = await filterEpisodesForUser(user.id, allowedRows)
  const byId = new Map(safeRows.map(r => [r.id, r]))

  const grouped = new Map<string, SearchResultEpisode>()
  const order: string[] = []
  for (const hit of raw) {
    const ep = byId.get(hit.episodeId)
    if (!ep) continue
    let entry = grouped.get(hit.episodeId)
    if (!entry) {
      entry = {
        episodeId: ep.id, title: ep.title,
        showId: ep.showId, showName: ep.showName,
        durationSec: ep.durationSec, publishedAt: ep.publishedAt,
        hits: [],
      }
      grouped.set(hit.episodeId, entry)
      order.push(hit.episodeId)  // raw is bm25-ordered, so first sighting = best rank
    }
    if (entry.hits.length < 4) {
      entry.hits.push({ startSec: hit.startSec, endSec: hit.endSec, snippet: hit.snippet })
    }
  }

  const ranked = order.map(id => grouped.get(id)!)
  // Embedding re-rank over the top slice: bm25 is lexical, so "how do I keep sourdough
  // alive" misses an episode that only ever says "feeding your starter". Best-effort:
  // any embedding failure leaves the bm25 order exactly as it was.
  const reranked = await rerankByEmbedding(q, ranked)
  return c.json({ results: ranked.slice(0, 30), reranked })
})

// ── Per-show auto-transcribe ──────────────────────────────────────────────────────

podcastAiRoute.put('/subscriptions/:showId/auto-transcribe', async (c) => {
  const user = c.get('user')
  const showId = c.req.param('showId')
  const body = await c.req.json<{ autoTranscribe?: boolean }>().catch(() => ({} as Record<string, never>))
  if (typeof body.autoTranscribe !== 'boolean') return c.json({ error: 'autoTranscribe required' }, 400)

  const [sub] = await db.select({ id: podcastSubscriptions.id }).from(podcastSubscriptions)
    .where(and(eq(podcastSubscriptions.userId, user.id), eq(podcastSubscriptions.showId, showId)))
    .limit(1)
  if (!sub) return c.json({ error: 'Not subscribed' }, 404)

  await db.update(podcastSubscriptions).set({ autoTranscribe: body.autoTranscribe })
    .where(eq(podcastSubscriptions.id, sub.id))
  return c.json({ ok: true })
})
