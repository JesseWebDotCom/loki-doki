// Resolver: turn a song identity (MusicBrainz recording, or a free artist+title pair) into a
// playable YouTube videoId. This is the seam between the catalog (identity) and playback
// (audio). Matching is fuzzy, so we score candidates and keep a permanent cache keyed by the
// recording MBID — once a song resolves, every surface (stations, playlists, search, offline)
// reuses the same id. A cached null is a memoised "nothing playable found".

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { createYouTubeFilter, createRemasteredFilter, decodeHtmlEntities, removeZeroWidth } from 'metadata-filter'
import { db } from '@/db'
import { musicResolve } from '@/db/schema'
import { innertubeSearch, SEARCH_FILTERS, type ItVideo } from '@/lib/youtube/innertube'
import { logger } from '@/lib/logger'

// Web Scrobbler's battle-tested title cleaner (refined against millions of YouTube music videos):
// handles "Official Video", lyrics, feat., remasters, parody, etc. We layer our own rules on top
// for the video-quality junk it intentionally leaves in (HD/HQ/4K/Vertical Video…).
const ytTitleFilter = createYouTubeFilter().extend(createRemasteredFilter())

export interface ResolveInput {
  mbid?: string | null      // MusicBrainz recording MBID, when known (best cache key)
  title: string
  artist: string
  durationSec?: number | null
}

export interface ResolvedTrack {
  videoId: string
  title: string
  artist: string
  durationSec: number | null
  score: number
}

// Title noise that almost always means "not the studio track the user asked for". Each hit
// subtracts from the score unless the user explicitly asked for it (checked against the query).
const NEGATIVE_TERMS = [
  'live', 'cover', 'reaction', 'remix', 'sped up', 'slowed', 'nightcore', 'karaoke',
  'instrumental', 'backing track', 'tutorial', '8d audio', 'loop', '1 hour', '10 hours', 'mashup', 'parody',
]

// Promo-noise tokens YouTube titles are littered with — used to strip bracketed groups and tails.
const TITLE_NOISE =
  'officia?l|music\\s*video|lyric\\s*video|lyrics?|with\\s*lyrics|visuali[sz]er|audio|' +
  'hd|hq|uhd|sd|full\\s*hd|4k(?:\\s*video)?|8k|2160p|1440p|1080p|720p|480p|m\\/?v|' +
  'vertical\\s*video|wide\\s*screen|remaster(?:ed)?(?:\\s*\\d{4})?|re-?master|anniversary(?:\\s*edition)?|' +
  'deluxe|bonus\\s*track|explicit|clean|dirty|radio\\s*edit|extended(?:\\s*(?:mix|version))?|' +
  'full\\s*(?:song|video|album)|promo|premiere|dolby|atmos|stereo|mono|mix|reupload|hd\\s*remaster|' +
  'colou?r\\s*coded|eng(?:lish)?\\s*sub(?:title)?s?|sub\\s*espa[nñ]ol|video\\s*version|' +
  'original\\s*(?:mix|version)|\\d{4}\\s*remaster|\\d{4}\\s*mix'

// Emoji and pictographic symbols to strip out of titles.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu

/** Clean a raw YouTube title into a tidy song title: strip emojis, @handles, a leading
 *  "Artist - " prefix, bracketed promo groups, trailing promo tails ("- HQ", "Official Video",
 *  "Full HD", "(Vertical Video)", bare years…), and surrounding quotes. */
export function cleanTrackTitle(raw: string, artist?: string): string {
  let t = removeZeroWidth(decodeHtmlEntities(raw ?? ''))                  // entities + zero-width
  t = t.replace(EMOJI_RE, ' ').replace(/@[\p{L}\p{N}._-]+/gu, ' ')        // emoji + @handles
  t = t.replace(/["“”«»]/g, '')                  // stray double quotes (keep apostrophes)
  t = t.replace(/\s*[-–—|·:]?\s*\b(?:cover\s+by|performed\s+by|by)\s*:\s*.+$/i, '')  // "… By: Artist" attribution
  t = (ytTitleFilter.filterField('track', t) || t).trim()                // Web Scrobbler cleaning
  t = t.replace(new RegExp(`[([{][^()[\\]{}]*\\b(?:${TITLE_NOISE})\\b[^()[\\]{}]*[)\\]}]`, 'gi'), '')  // bracketed promo
  t = t.replace(/[([{]\s*(?:19|20)\d{2}\s*[)\]}]/g, '')                   // bracketed bare year "(2011)"
  if (artist) {
    const a = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    t = t.replace(new RegExp(`^\\s*(?:${a}\\s*[-–—:|]\\s*)+`, 'i'), '')   // leading "Artist - " (repeated)
    t = t.replace(new RegExp(`\\s*[-–—:|]\\s*"?${a}"?\\s*$`, 'i'), '')    // trailing "- Artist" ("Title" - Artist)
  }
  // Trailing promo tails after a separator (repeat to peel chains like "- Official Video - HQ").
  for (let i = 0; i < 5; i++) {
    const before = t
    t = t.replace(new RegExp(`\\s*[-–—|·:~]\\s*(?:${TITLE_NOISE})\\b[^([{]*$`, 'i'), '')
    t = t.replace(/\s*[-–—|·:~]\s*(?:19|20)\d{2}\s*$/g, '')               // trailing bare year "- 1973"
    if (t === before) break
  }
  // Trailing promo with no separator: "Billie Jean Official Video", "… Full HD"
  t = t.replace(/\s+(?:officia?l\s+(?:music\s+|lyric\s+)?(?:video|audio|visuali[sz]er)|full\s*hd|4k\s*video|vertical\s*video|hq\s*audio)\s*$/gi, '')
  t = t.replace(/[([{]\s*[)\]}]/g, ' ').replace(/\s{2,}/g, ' ')          // empty leftover brackets (double quotes already removed)
  t = t.replace(/^[\s\-–—|·:~]+|[\s\-–—|·:~]+$/g, '').trim()              // dangling separators
  return t || (raw ?? '')
}

// Shared text normalizer for fuzzy matching. Also used by the local-library scanner
// (norm_title/norm_artist columns) and resolveSource matching — if this ever changes,
// stored norms must be recomputed or library matching silently drifts.
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
const tokens = (s: string) => new Set(norm(s).split(' ').filter(Boolean))

function keyFor(input: ResolveInput): string {
  if (input.mbid) return input.mbid
  const h = createHash('sha256').update(norm(`${input.artist}|${input.title}`)).digest('hex').slice(0, 24)
  return `q:${h}`
}

// Score a single YouTube candidate against the wanted song. Higher is better; the caller keeps
// the max and rejects anything below a floor.
function scoreCandidate(cand: ItVideo, want: ResolveInput, queryNorm: string): number {
  const hay = `${cand.title ?? ''} ${cand.author ?? ''}`
  const hayNorm = norm(hay)
  const titleToks = tokens(want.title)
  const artistToks = tokens(want.artist)
  const candToks = tokens(hay)

  // Token coverage: how much of the wanted title/artist shows up in the candidate.
  const covered = (set: Set<string>) => {
    if (!set.size) return 1
    let n = 0
    for (const t of set) if (candToks.has(t)) n++
    return n / set.size
  }
  const titleCov = covered(titleToks)
  const artistCov = covered(artistToks)

  let score = titleCov * 5 + artistCov * 3

  // Official-source signals. "- Topic" channels are YouTube's auto-generated official audio.
  const author = (cand.author ?? '').toLowerCase()
  if (author.endsWith('- topic')) score += 4
  if (/\bofficial\b.*\b(audio|music video|video)\b/.test(hayNorm)) score += 2
  if (/\baudio\b/.test(hayNorm)) score += 0.5
  if (/\bvevo\b/.test(author)) score += 1.5
  if (/\bofficial\b/.test(author)) score += 1

  // Negative terms — but only penalize if the user didn't ask for them.
  for (const term of NEGATIVE_TERMS) {
    if (hayNorm.includes(term) && !queryNorm.includes(term)) score -= 3
  }

  // Duration proximity (studio tracks match the recording length closely).
  if (want.durationSec && cand.durationSec) {
    const diff = Math.abs(cand.durationSec - want.durationSec)
    if (diff <= 5) score += 3
    else if (diff <= 12) score += 1
    else if (diff > 60) score -= 2
  }
  // Penalize obvious non-songs (hour-long mixes) unless the target is genuinely long.
  if (cand.durationSec && cand.durationSec > 900 && (!want.durationSec || want.durationSec < 600)) {
    score -= 4
  }

  return score
}

/**
 * Resolve one song to a YouTube videoId, using (and populating) the persistent cache.
 * Returns null when nothing scores above the confidence floor — and caches that miss so we
 * don't re-search a known dead end on every play.
 */
export async function resolveTrack(input: ResolveInput): Promise<ResolvedTrack | null> {
  const key = keyFor(input)

  const [cached] = await db
    .select()
    .from(musicResolve)
    .where(eq(musicResolve.key, key))
    .limit(1)
  if (cached) {
    if (!cached.videoId) return null
    return {
      videoId: cached.videoId,
      title: cleanTrackTitle(cached.title ?? input.title, cached.artist ?? input.artist),
      artist: cached.artist ?? input.artist,
      durationSec: cached.durationSec ?? input.durationSec ?? null,
      score: cached.score ?? 0,
    }
  }

  const query = `${input.artist} ${input.title}`.trim()
  const queryNorm = norm(query)
  let best: { cand: ItVideo; score: number } | null = null
  try {
    const search = await innertubeSearch(query, 10, 0, 8000, 0, SEARCH_FILTERS.videos)
    for (const cand of search.videos ?? []) {
      if (!cand.videoId) continue
      const score = scoreCandidate(cand, input, queryNorm)
      if (!best || score > best.score) best = { cand, score }
    }
  } catch (err) {
    // A search failure is transient — do NOT cache it; let the next play retry.
    logger.debug(`[resolve] search failed for "${query}": ${String(err)}`)
    return null
  }

  // Confidence floor: must at least match most of the title.
  const FLOOR = 4
  const resolved: ResolvedTrack | null = best && best.score >= FLOOR
    ? {
        videoId: best.cand.videoId,
        title: cleanTrackTitle(best.cand.title ?? input.title, input.artist),
        artist: input.artist || best.cand.author || '',
        durationSec: best.cand.durationSec ?? input.durationSec ?? null,
        score: best.score,
      }
    : null

  // Persist the answer (including a miss) so it's reused everywhere.
  await db
    .insert(musicResolve)
    .values({
      key,
      videoId: resolved?.videoId ?? null,
      title: resolved?.title ?? input.title,
      artist: resolved?.artist ?? input.artist,
      durationSec: resolved?.durationSec ?? input.durationSec ?? null,
      score: resolved?.score ?? 0,
      resolvedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: musicResolve.key,
      set: {
        videoId: resolved?.videoId ?? null,
        title: resolved?.title ?? input.title,
        artist: resolved?.artist ?? input.artist,
        durationSec: resolved?.durationSec ?? input.durationSec ?? null,
        score: resolved?.score ?? 0,
        resolvedAt: new Date(),
      },
    })

  return resolved
}

/** Resolve many tracks, preserving order and dropping unresolvable ones. Runs with bounded
 *  concurrency so a 20-song queue doesn't take 20 sequential InnerTube round-trips — cached
 *  hits resolve instantly, fresh ones resolve a few at a time. */
export async function resolveTracks(inputs: ResolveInput[], concurrency = 6): Promise<ResolvedTrack[]> {
  const results: (ResolvedTrack | null)[] = new Array(inputs.length).fill(null)
  let cursor = 0
  async function worker() {
    while (cursor < inputs.length) {
      const idx = cursor++
      results[idx] = await resolveTrack(inputs[idx]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker))
  return results.filter((r): r is ResolvedTrack => r !== null)
}
