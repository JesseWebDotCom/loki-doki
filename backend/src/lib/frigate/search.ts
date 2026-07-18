// Natural-language footage search over stored Frigate events ("the dog in the
// backyard yesterday", "person at the front door with a package"). This is the local,
// free answer to iOS 27's iCloud-gated Home-app camera search: it reuses the same
// nomic-embed-text + cosine stack as memory/notes/video semantic search. Event
// embeddings are populated lazily at search time and persisted on the row, so the
// ingest hot path stays untouched and repeat searches are fast.

import { and, desc, eq, or, like, gte } from 'drizzle-orm'
import { db } from '@/db'
import { frigateEvents } from '@/db/schema'
import { embed, cachedVector, cosineSimilarity } from '@/llm/embed'
import { logger } from '@/lib/logger'

export interface FrigateSearchHit {
  id: string
  camera: string | null
  label: string | null
  subLabel: string | null
  title: string | null
  description: string | null
  snapshotUrl: string | null
  clipUrl: string | null
  createdAt: number
  score: number
}

/** The text we embed / match for one event. */
function eventText(e: { camera: string | null; label: string | null; subLabel: string | null; title: string | null; description: string | null }): string {
  return [humanCamera(e.camera), e.label, e.subLabel, e.title, e.description]
    .filter(Boolean).join('. ').trim()
}

function humanCamera(camera: string | null): string {
  if (!camera) return ''
  return camera.replace(/[_-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase())
}

// A coarse time-window parse so "yesterday" / "today" / "this week" narrows the set
// before ranking. Returns a lower bound (epoch ms) or null. Uses the caller-supplied
// `now` so this stays deterministic and testable.
export function parseSince(q: string, now: number): number | null {
  const s = q.toLowerCase()
  const DAY = 86_400_000
  if (/\btoday\b/.test(s)) return now - DAY
  if (/\byesterday\b/.test(s)) return now - 2 * DAY
  if (/\bthis week\b|\bpast week\b|\blast few days\b/.test(s)) return now - 7 * DAY
  if (/\bthis month\b|\bpast month\b/.test(s)) return now - 30 * DAY
  return null
}

/** Cap on how many un-embedded candidates we embed+persist per search, so one query
 *  can't stall on a cold table; the rest fill in over subsequent searches. */
const EMBED_BUDGET = 40

export async function searchFrigateEvents(
  query: string,
  opts: { limit?: number; now: number },
): Promise<FrigateSearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const limit = Math.min(opts.limit ?? 20, 50)

  const since = parseSince(q, opts.now)
  const conds = [or(
    like(frigateEvents.description, `%${q}%`),
    like(frigateEvents.title, `%${q}%`),
    like(frigateEvents.label, `%${q}%`),
    like(frigateEvents.subLabel, `%${q}%`),
    like(frigateEvents.camera, `%${q}%`),
  )]
  // Candidate pool: recent events (optionally time-bounded). We over-fetch and re-rank.
  const timeCond = since ? gte(frigateEvents.createdAt, new Date(since)) : undefined
  const candidates = await db
    .select()
    .from(frigateEvents)
    .where(timeCond ? and(timeCond) : undefined)
    .orderBy(desc(frigateEvents.createdAt))
    .limit(400)

  const usable = candidates.filter((e) => eventText(e).length > 0)
  if (usable.length === 0) return []

  let queryVec: number[]
  try {
    queryVec = await embed(q)
  } catch (err) {
    logger.warn(`[frigate-search] query embed failed, falling back to keyword: ${err}`)
    // Keyword fallback: return LIKE matches newest-first.
    const kw = await db.select().from(frigateEvents)
      .where(and(conds[0]!, ...(timeCond ? [timeCond] : [])))
      .orderBy(desc(frigateEvents.createdAt))
      .limit(limit)
    return kw.map((e) => toHit(e, 0))
  }

  let embedBudget = EMBED_BUDGET
  const scored: FrigateSearchHit[] = []
  for (const e of usable) {
    let vec = e.embedding ? cachedVector(`frig:${e.id}`, e.embedding) : null
    if (!vec && embedBudget > 0) {
      embedBudget--
      try {
        vec = await embed(eventText(e))
        // Persist so the next search is fast; fire-and-forget.
        void db.update(frigateEvents).set({ embedding: JSON.stringify(vec) }).where(eq(frigateEvents.id, e.id)).catch(() => {})
      } catch { vec = null }
    }
    if (!vec) continue
    scored.push(toHit(e, cosineSimilarity(queryVec, vec)))
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

function toHit(e: typeof frigateEvents.$inferSelect, score: number): FrigateSearchHit {
  return {
    id: e.id,
    camera: e.camera,
    label: e.label,
    subLabel: e.subLabel,
    title: e.title,
    description: e.description,
    snapshotUrl: e.snapshotUrl,
    clipUrl: e.clipUrl,
    createdAt: e.createdAt instanceof Date ? e.createdAt.getTime() : (e.createdAt as unknown as number),
    score,
  }
}
