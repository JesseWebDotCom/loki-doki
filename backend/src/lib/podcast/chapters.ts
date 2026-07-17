// Per-episode chapters, one shape for both worlds:
//   - Generated episodes: the AI pipeline already writes chaptersJson at build time.
//   - Subscribed RSS episodes: Podcasting 2.0 <podcast:chapters> points at a JSON
//     document; we fetch it lazily on first request and cache the normalized result
//     into the same chaptersJson column (chaptersFetchedAt marks the attempt so a
//     chapterless or broken URL is not re-fetched on every open).

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { podcastEpisodes } from '@/db/schema'
import { safeFetch } from '@/lib/ssrfGuard'
import type { EpisodeChapter } from '@/lib/podcast/types'

const FETCH_TIMEOUT_MS = 12_000
const MAX_DOC_BYTES = 512 * 1024
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000  // stale cache re-checked weekly

function parseChaptersJson(raw: string | null): EpisodeChapter[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((c): c is { title?: unknown; startSec?: unknown } => !!c && typeof c === 'object')
      .map(c => ({ title: String(c.title ?? ''), startSec: Number(c.startSec ?? 0) }))
      .filter(c => c.title && Number.isFinite(c.startSec) && c.startSec >= 0)
  } catch {
    return []
  }
}

/** Normalize a Podcasting 2.0 chapters document (https://podcastindex.org/namespace/1.0
 *  "chapters" JSON: { chapters: [{ startTime, title, ... }] }) to our EpisodeChapter[]. */
function normalizePc20(doc: unknown): EpisodeChapter[] {
  if (!doc || typeof doc !== 'object') return []
  const list = (doc as { chapters?: unknown }).chapters
  if (!Array.isArray(list)) return []
  const out: EpisodeChapter[] = []
  for (const c of list) {
    if (!c || typeof c !== 'object') continue
    const start = Number((c as { startTime?: unknown }).startTime)
    if (!Number.isFinite(start) || start < 0) continue
    // Untitled chapters (art-only markers are legal in PC2.0) get a positional name.
    const title = String((c as { title?: unknown }).title ?? '').trim() || `Chapter ${out.length + 1}`
    // toc:false marks a chapter that should not appear in the table of contents.
    if ((c as { toc?: unknown }).toc === false) continue
    out.push({ title: title.slice(0, 200), startSec: Math.round(start) })
  }
  out.sort((a, b) => a.startSec - b.startSec)
  return out.slice(0, 400)
}

/** Resolve the chapters for one episode, fetching + caching the remote PC2.0 document
 *  when needed. Returns [] when the episode has no chapters from any source. */
export async function getEpisodeChapters(episodeId: string): Promise<EpisodeChapter[]> {
  const [ep] = await db.select({
    chaptersJson: podcastEpisodes.chaptersJson,
    chaptersUrl: podcastEpisodes.chaptersUrl,
    chaptersFetchedAt: podcastEpisodes.chaptersFetchedAt,
  }).from(podcastEpisodes).where(eq(podcastEpisodes.id, episodeId))
  if (!ep) return []

  const cached = parseChaptersJson(ep.chaptersJson)
  if (cached.length) return cached
  if (!ep.chaptersUrl) return []

  // A previous fetch already ran (and produced nothing usable): only retry weekly.
  if (ep.chaptersFetchedAt && Date.now() - ep.chaptersFetchedAt.getTime() < REFRESH_AFTER_MS) return []

  let chapters: EpisodeChapter[] = []
  try {
    const res = await safeFetch(ep.chaptersUrl, {
      headers: { 'User-Agent': 'LokiDoki/3.0 podcast', Accept: 'application/json, */*' },
    }, { timeoutMs: FETCH_TIMEOUT_MS })
    if (res.ok) {
      const text = await res.text()
      if (text.length <= MAX_DOC_BYTES) {
        try { chapters = normalizePc20(JSON.parse(text)) } catch { /* not JSON */ }
      }
    } else {
      res.body?.cancel().catch(() => {})
    }
  } catch { /* unreachable host / SSRF-blocked / timeout - cache the miss below */ }

  await db.update(podcastEpisodes).set({
    ...(chapters.length ? { chaptersJson: JSON.stringify(chapters) } : {}),
    chaptersFetchedAt: new Date(),
  }).where(eq(podcastEpisodes.id, episodeId))

  return chapters
}
