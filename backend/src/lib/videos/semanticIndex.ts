// Semantic search across the household's video library: "find the video where they fix
// the dishwasher latch". Everything anyone watches gets indexed organically: the title/
// description as one embedding row, and the transcript (when the source has captions)
// chunked into ~45-90s windows with their start times, so results can jump straight to
// the matching moment. Embeddings ride the existing local stack (nomic-embed-text via
// Ollama, JSON-text vectors + the shared parsed-vector cache, same as memory recall).

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { videoEmbeddings, videoItems, ytVideos, videoWatchState, ytWatchState, users } from '@/db/schema'
import { embed, cachedVector, cosineSimilarity } from '@/llm/embed'
import { ensureTranscript } from '@/lib/youtube/download'
import { resolveVideoVtt } from '@/lib/podcast/transcript'
import { filterVideosForUser } from '@/lib/videos/policy'
import { logger } from '@/lib/logger'
import type { VideoItem } from '@/lib/videos/types'
import { readFile } from 'node:fs/promises'

// ── VTT parsing ──────────────────────────────────────────────────────────────────

interface Cue { start: number; text: string }

function parseTs(ts: string): number {
  const m = ts.trim().match(/^(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})$/)
  if (!m) return 0
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]) + Number(m[4]) / 1000
}

/** Timed cues from a VTT, with inline tags stripped and rolling-caption dupes removed. */
export function parseVttCues(vtt: string): Cue[] {
  const cues: Cue[] = []
  let last = ''
  for (const block of vtt.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const timingIdx = lines.findIndex((l) => l.includes('-->'))
    if (timingIdx < 0) continue
    const start = parseTs(lines[timingIdx]!.split('-->')[0] ?? '')
    const text = lines.slice(timingIdx + 1).join(' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim()
    if (!text || text === last) continue
    // Rolling captions repeat the previous line as a prefix; keep only the new tail.
    const fresh = last && text.startsWith(last) ? text.slice(last.length).trim() : text
    last = text
    if (fresh) cues.push({ start, text: fresh })
  }
  return cues
}

/** Group cues into embedding-sized windows; window grows for very long videos so the
 *  per-video chunk count stays bounded (~60). */
export function chunkCues(cues: Cue[]): Array<{ start: number; text: string }> {
  if (!cues.length) return []
  const totalChars = cues.reduce((a, c) => a + c.text.length, 0)
  const target = Math.max(500, Math.ceil(totalChars / 60))
  const chunks: Array<{ start: number; text: string }> = []
  let cur = { start: cues[0]!.start, text: '' }
  for (const c of cues) {
    if (cur.text && cur.text.length + c.text.length > target) {
      chunks.push({ start: cur.start, text: cur.text.trim() })
      cur = { start: c.start, text: '' }
    }
    cur.text += ` ${c.text}`
  }
  if (cur.text.trim()) chunks.push({ start: cur.start, text: cur.text.trim() })
  return chunks
}

// ── Indexing ─────────────────────────────────────────────────────────────────────

const inFlight = new Set<string>()
const knownIndexed = new Set<string>()   // process-lifetime "already checked" cache

async function alreadyIndexed(source: string, videoId: string): Promise<boolean> {
  const key = `${source}:${videoId}`
  if (knownIndexed.has(key)) return true
  const [row] = await db.select({ id: videoEmbeddings.id }).from(videoEmbeddings)
    .where(and(eq(videoEmbeddings.source, source), eq(videoEmbeddings.videoId, videoId)))
    .limit(1)
  if (row) { knownIndexed.add(key); return true }
  return false
}

export interface IndexMeta {
  title?: string | null
  description?: string | null
  creatorName?: string | null
  /** Needed to fetch transcripts (they cache under the requesting user's dir). */
  userId: string
  userFirstName: string
  /** Original page URL, required for non-YouTube transcript fetches. */
  url?: string | null
}

/** Fire-and-forget: index one video (meta row + transcript chunks) if not indexed yet. */
export function ensureVideoIndexed(source: string, videoId: string, meta: IndexMeta): void {
  const key = `${source}:${videoId}`
  if (inFlight.has(key) || knownIndexed.has(key)) return
  inFlight.add(key)
  void (async () => {
    try {
      if (await alreadyIndexed(source, videoId)) return
      await indexVideo(source, videoId, meta)
      knownIndexed.add(key)
    } catch (err) {
      logger.debug(`[videos/semantic] index failed for ${key}: ${String(err)}`)
    } finally {
      inFlight.delete(key)
    }
  })()
}

async function indexVideo(source: string, videoId: string, meta: IndexMeta): Promise<void> {
  // Resolve title/creator from caches when the caller didn't carry them.
  let title = meta.title ?? null
  let creator = meta.creatorName ?? null
  let description = meta.description ?? null
  if (!title) {
    if (source === 'youtube') {
      const [v] = await db.select({ title: ytVideos.title, author: ytVideos.author })
        .from(ytVideos).where(eq(ytVideos.videoId, videoId)).limit(1)
      title = v?.title ?? null; creator = creator ?? v?.author ?? null
    } else {
      const [v] = await db.select({ title: videoItems.title, creatorName: videoItems.creatorName })
        .from(videoItems).where(and(eq(videoItems.source, source), eq(videoItems.externalId, videoId))).limit(1)
      title = v?.title ?? null; creator = creator ?? v?.creatorName ?? null
    }
  }
  if (!title) return   // nothing usable to index yet

  const rows: Array<{ segment: number; startSec: number | null; text: string }> = []
  const metaText = [title, creator, description?.slice(0, 500)].filter(Boolean).join(' — ')
  rows.push({ segment: -1, startSec: null, text: metaText })

  // Transcript chunks (best-effort; YouTube via its caption cache, hub via yt-dlp VTT).
  try {
    let vtt: string | null = null
    if (source === 'youtube') {
      const p = await ensureTranscript(videoId, meta.userId, meta.userFirstName)
      if (p) vtt = await readFile(p, 'utf-8').catch(() => null)
    } else {
      vtt = await resolveVideoVtt({ source, videoId, url: meta.url ?? undefined }, meta.userId, meta.userFirstName)
    }
    if (vtt) {
      const chunks = chunkCues(parseVttCues(vtt))
      chunks.forEach((ch, i) => rows.push({ segment: i, startSec: Math.floor(ch.start), text: ch.text.slice(0, 2000) }))
    }
  } catch { /* caption-less video: title row still lands */ }

  const now = new Date()
  for (const r of rows) {
    try {
      const vector = await embed(`${title}\n${r.text}`.slice(0, 4000))
      await db.insert(videoEmbeddings).values({
        id: crypto.randomUUID(), source, videoId,
        segment: r.segment, startSec: r.startSec, text: r.text.slice(0, 500),
        embedding: JSON.stringify(vector), updatedAt: now,
      }).onConflictDoUpdate({
        target: [videoEmbeddings.source, videoEmbeddings.videoId, videoEmbeddings.segment],
        set: { startSec: r.startSec, text: r.text.slice(0, 500), embedding: JSON.stringify(vector), updatedAt: now },
      })
    } catch (err) {
      logger.debug(`[videos/semantic] embed failed (${source}:${videoId}#${r.segment}): ${String(err)}`)
      return   // Ollama likely down; stop burning attempts, a later watch retriggers
    }
  }
  logger.debug(`[videos/semantic] indexed ${source}:${videoId} (${rows.length} rows)`)
}

// ── Backfill: index recent watch history that predates the index ────────────────────

export function startSemanticBackfill(): { stop: () => void } {
  let stopped = false
  void (async () => {
    // Let boot settle before spending yt-dlp/Ollama cycles.
    await new Promise((r) => setTimeout(r, 3 * 60_000))
    try {
      const family = await db.select({ id: users.id, firstName: users.firstName }).from(users)
      const nameOf = new Map(family.map((u) => [u.id, u.firstName]))
      const yt = await db.select({
        videoId: ytWatchState.videoId, userId: ytWatchState.userId,
      }).from(ytWatchState).limit(150)
      const hub = await db.select({
        source: videoWatchState.source, videoId: videoWatchState.videoId, userId: videoWatchState.userId,
      }).from(videoWatchState).limit(150)
      const work = [
        ...yt.map((r) => ({ source: 'youtube', videoId: r.videoId, userId: r.userId })),
        ...hub.map((r) => ({ source: r.source, videoId: r.videoId, userId: r.userId })),
      ]
      for (const w of work) {
        if (stopped) return
        if (await alreadyIndexed(w.source, w.videoId)) continue
        ensureVideoIndexed(w.source, w.videoId, { userId: w.userId, userFirstName: nameOf.get(w.userId) ?? 'user' })
        // Generous spacing: transcripts may shell out to yt-dlp.
        await new Promise((r) => setTimeout(r, 20_000))
      }
    } catch (err) {
      logger.debug(`[videos/semantic] backfill aborted: ${String(err)}`)
    }
  })()
  return { stop: () => { stopped = true } }
}

// ── Search ───────────────────────────────────────────────────────────────────────

export interface SemanticHit {
  source: string
  videoId: string
  title: string
  creatorName: string | null
  thumbnailUrl: string | null
  score: number
  /** Best-matching transcript moment (null when the match was title/description). */
  seekSec: number | null
  snippet: string | null
}

export async function semanticSearch(userId: string, query: string, limit = 20): Promise<SemanticHit[]> {
  const q = query.trim()
  if (q.length < 3) return []
  let qVec: number[]
  try { qVec = await embed(q) } catch { return [] }

  const rows = await db.select().from(videoEmbeddings)
  interface Best { score: number; seekSec: number | null; snippet: string | null }
  const best = new Map<string, Best>()
  for (const row of rows) {
    const vec = cachedVector(`${row.id}:${row.updatedAt.getTime()}`, row.embedding)
    if (!vec) continue
    const score = cosineSimilarity(qVec, vec)
    const key = `${row.source}:${row.videoId}`
    const cur = best.get(key)
    if (!cur || score > cur.score) {
      best.set(key, {
        score,
        seekSec: row.segment >= 0 ? row.startSec : null,
        snippet: row.segment >= 0 ? row.text : null,
      })
    }
  }

  const ranked = Array.from(best.entries()).sort((a, b) => b[1].score - a[1].score).slice(0, limit * 2)
  if (!ranked.length) return []

  // Hydrate titles/thumbnails and pass the results through the content policy chokepoint
  // (ceilings + approved-only both apply to search like everywhere else).
  const items: VideoItem[] = []
  const hitByKey = new Map<string, Best>()
  for (const [key, hit] of ranked) {
    const [source, videoId] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    hitByKey.set(key, hit)
    if (source === 'youtube') {
      const [v] = await db.select({ title: ytVideos.title, author: ytVideos.author, channelId: ytVideos.channelId, thumbnailUrl: ytVideos.thumbnailUrl })
        .from(ytVideos).where(eq(ytVideos.videoId, videoId)).limit(1)
      if (v?.title) items.push({
        source: 'youtube' as never, id: videoId, url: `https://www.youtube.com/watch?v=${videoId}`,
        title: v.title, creator: v.channelId ? { id: v.channelId, name: v.author ?? '' } : null,
        thumbnailUrl: v.thumbnailUrl,
      })
    } else {
      const [v] = await db.select({ title: videoItems.title, creatorId: videoItems.creatorId, creatorName: videoItems.creatorName, thumbnailUrl: videoItems.thumbnailUrl, isAdult: videoItems.isAdult })
        .from(videoItems).where(and(eq(videoItems.source, source), eq(videoItems.externalId, videoId))).limit(1)
      if (v?.title) items.push({
        source: source as never, id: videoId, url: '',
        title: v.title, creator: v.creatorId ? { id: v.creatorId, name: v.creatorName ?? '' } : null,
        thumbnailUrl: v.thumbnailUrl, isAdult: v.isAdult,
      })
    }
  }
  const allowed = await filterVideosForUser(userId, items)
  return allowed.slice(0, limit).map((it) => {
    const hit = hitByKey.get(`${it.source}:${it.id}`)!
    return {
      source: it.source, videoId: it.id, title: it.title,
      creatorName: it.creator?.name ?? null, thumbnailUrl: it.thumbnailUrl ?? null,
      score: hit.score, seekSec: hit.seekSec, snippet: hit.snippet,
    }
  })
}
