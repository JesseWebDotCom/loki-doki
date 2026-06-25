// Station engine — turns a station's AI prompt (or an artist/song seed) into a concrete,
// playable queue. This is the heart of the "AI stations" feature:
//
//   prompt  → LLM proposes a tracklist → resolve each to YouTube → backfill gaps
//   artist/ → resolve the seed song → YouTube Music's auto-curated radio mix (long, varied,
//   song     genre-appropriate; the same proven path the old AI Radio used)
//
// We deliberately do NOT round-trip every proposed track through MusicBrainz (it's 1 req/sec —
// 20 tracks would stall a tune-in for ~20s). The resolver's confidence floor is the guard: a
// hallucinated song simply won't find a good YouTube match and gets dropped. MusicBrainz stays
// the browse/identity layer; the queue builder optimizes for fast, reliable resolution.

import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { ytmusicRadio, ytmusicSearch } from '@/lib/youtube/ytmusic'
import { resolveTrack, resolveTracks, cleanTrackTitle, type ResolvedTrack } from '@/lib/music/resolve'
import { logger } from '@/lib/logger'

export type StationSeedType = 'prompt' | 'genre' | 'artist' | 'song'

export interface StationSeed {
  name?: string
  aiPrompt: string                 // freeform description of the vibe / what to play
  seedType?: StationSeedType
  seedValue?: string               // artist or song name when seedType is artist/song
  seedVideoId?: string             // exact YouTube id to ride a radio mix off (fast, no LLM)
  count?: number                   // desired queue length (default 24)
  excludeVideoIds?: string[]       // already-played, to vary repeat tune-ins
}

export interface StationQueueResult {
  tracks: ResolvedTrack[]
  source: 'playlist' | 'llm' | 'ytmusic' | 'mixed' | 'empty'
}

// ── YouTube Music sourcing ───────────────────────────────────────────────────────────
// Source prompt/themed stations from YouTube Music search, which is music-ONLY by construction —
// no film clips, camera reviews, video essays, trailers, or other non-music videos can appear
// (unlike blending mixed regular-YouTube playlists). We search the station's name and prompt for
// real songs, then extend with YouTube Music's radio off the top hit for breadth and freshness.

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j]!, arr[i]!] }
  return arr
}

const toResolved = (t: { videoId: string; title: string; author: string | null }): ResolvedTrack => ({
  videoId: t.videoId, title: cleanTrackTitle(t.title, t.author ?? undefined), artist: t.author ?? '', durationSec: null, score: 1,
})

const QUERIES_SCHEMA = {
  type: 'object',
  properties: { queries: { type: 'array', items: { type: 'string' } } },
  required: ['queries'],
} as const

// Turn the station concept into concise YouTube Music SEARCH queries. The LLM is reliable at this
// (concept → search terms) and — unlike listing specific songs — can't hallucinate tracks. The
// brand-y station name ("Tarantino Needle-Drops") is a poor literal search; "tarantino soundtrack",
// "70s funk soul soundtrack" etc. surface the right songs.
async function llmSearchQueries(seed: StationSeed): Promise<string[]> {
  try {
    const model = await getModel()
    const sys = 'You convert a radio-station description into concise YouTube Music search queries that ' +
      'surface the RIGHT SONGS. Return 3-5 short queries (2-5 words each) that a music fan would type. ' +
      'Use genre, era, mood, soundtrack, and artist terms; avoid brand names and full sentences. ' +
      'Honor any era/decade in the description. Output JSON only.'
    const user = `Station name: "${seed.name ?? ''}". Description: "${seed.aiPrompt}". Give 3-5 search queries.`
    const chat = await ollamaChat(model, [{ role: 'system', content: sys }, { role: 'user', content: user }], [], { temperature: 0.6, num_predict: 200 }, QUERIES_SCHEMA)
    const parsed = JSON.parse(chat.message?.content?.trim() || '{}') as { queries?: string[] }
    const queries = (parsed.queries ?? []).map(q => q.trim()).filter(q => q.length > 1).slice(0, 5)
    return queries
  } catch (err) {
    logger.debug(`[stationEngine] llmSearchQueries failed: ${String(err)}`)
    return []
  }
}

async function ytmusicMix(seed: StationSeed, want: number, exclude: Set<string>): Promise<ResolvedTrack[]> {
  // Prefer LLM-derived concise queries; fall back to the raw name/prompt.
  let queries = await llmSearchQueries(seed)
  if (!queries.length) {
    queries = [seed.name, seed.aiPrompt].filter((q): q is string => !!q && q.trim().length > 1).map(q => q.slice(0, 90).trim())
  }
  if (!queries.length) return []

  const seen = new Set<string>(exclude)
  const out: ResolvedTrack[] = []
  // Pull a spread of music-only songs from each query (cap per query so no single one dominates).
  const perQuery = Math.max(3, Math.ceil(want / queries.length) + 1)
  for (const q of queries) {
    if (out.length >= want) break
    let added = 0
    for (const t of await ytmusicSearch(q, perQuery + 5)) {
      if (out.length >= want || added >= perQuery) break
      if (!t.videoId || seen.has(t.videoId)) continue
      seen.add(t.videoId); out.push(toResolved(t)); added++
    }
  }
  // Extend with a YouTube Music radio mix off the top hit, for length + per-tune-in variety.
  if (out.length && out.length < want) {
    for (const t of await ytmusicRadio(out[0]!.videoId)) {
      if (out.length >= want) break
      if (!t.videoId || seen.has(t.videoId)) continue
      seen.add(t.videoId); out.push(toResolved(t))
    }
  }
  return shuffle(out).slice(0, want)
}

const TRACKLIST_SCHEMA = {
  type: 'object',
  properties: {
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { artist: { type: 'string' }, title: { type: 'string' } },
        required: ['artist', 'title'],
      },
    },
  },
  required: ['tracks'],
} as const

// Ask the model for a concrete tracklist that fits the station's prompt. Returns real-sounding
// {artist,title} pairs; resolution is what ultimately validates them.
async function llmTracklist(seed: StationSeed, want: number): Promise<Array<{ artist: string; title: string }>> {
  const model = await getModel()
  const exclude = seed.excludeVideoIds?.length
    ? ' Vary your picks from any obvious greatest-hits ordering so repeat listens feel fresh.'
    : ''
  const sys = 'You are a world-class music programmer building a radio station playlist. Rules: ' +
    '(1) Only real, existing songs with the correct artist and exact title. ' +
    '(2) STRICTLY honor every constraint in the brief — especially era or decade (include ONLY songs ' +
    'originally released in that period), genre, mood, and region. Never include a song that violates ' +
    'the brief, even if it is famous. For example, for an "80s" station do not include 70s or 90s songs. ' +
    '(3) Favor well-known, findable recordings over obscure deep cuts unless the brief asks otherwise. ' +
    '(4) No duplicates, no made-up songs, no commentary.'
  const user = `Build a ${want}-song playlist for a station described as: "${seed.aiPrompt}".` +
    (seed.name ? ` The station is called "${seed.name}".` : '') +
    ` Every single song must genuinely fit that brief — double-check the decade/era and genre of each pick.` +
    `${exclude} Return ${want} songs as JSON.`

  try {
    const chat = await ollamaChat(
      model,
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      [],
      { temperature: 0.8, num_predict: 700 },
      TRACKLIST_SCHEMA,
    )
    const raw = chat.message?.content?.trim()
    if (!raw) return []
    const parsed = JSON.parse(raw) as { tracks?: Array<{ artist?: string; title?: string }> }
    const seen = new Set<string>()
    const out: Array<{ artist: string; title: string }> = []
    for (const t of parsed.tracks ?? []) {
      const artist = (t.artist ?? '').trim()
      const title = (t.title ?? '').trim()
      if (!title) continue
      const k = `${artist}|${title}`.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ artist, title })
    }
    return out
  } catch (err) {
    logger.debug(`[stationEngine] llmTracklist failed: ${String(err)}`)
    return []
  }
}

// Wrap YouTube Music radio tracks (already real videoIds) as ResolvedTrack — no resolve needed.
function fromYtmusic(tracks: Array<{ videoId: string; title: string; author: string | null }>, exclude: Set<string>): ResolvedTrack[] {
  const out: ResolvedTrack[] = []
  for (const t of tracks) {
    if (exclude.has(t.videoId)) continue
    out.push({ videoId: t.videoId, title: t.title, artist: t.author ?? '', durationSec: null, score: 1 })
  }
  return out
}

/**
 * Build a playable queue for a station. Picks the strategy from the seed type, resolves to
 * YouTube, and backfills from YouTube Music radio when the LLM path comes up short.
 */
export async function buildStationQueue(seed: StationSeed): Promise<StationQueueResult> {
  const want = Math.min(Math.max(seed.count ?? 24, 6), 50)
  const exclude = new Set(seed.excludeVideoIds ?? [])

  // Known videoId → ride YouTube Music's radio mix off it directly (no resolve, no LLM). This is
  // the fast path behind "play this exact song now".
  if (seed.seedVideoId) {
    const mix = await ytmusicRadio(seed.seedVideoId)
    const tracks = fromYtmusic(mix, exclude)
    if (tracks.length) return { tracks: dedupe(tracks).slice(0, want), source: 'ytmusic' }
  }

  // Artist / song seed → resolve the seed, then ride YouTube Music's curated radio mix.
  if ((seed.seedType === 'artist' || seed.seedType === 'song') && seed.seedValue) {
    const seedTrack = await resolveTrack(seed.seedType === 'song'
      ? { title: seed.seedValue, artist: '' }
      : { title: '', artist: seed.seedValue })
    if (seedTrack) {
      const mix = await ytmusicRadio(seedTrack.videoId)
      const tracks = [seedTrack, ...fromYtmusic(mix, new Set([...exclude, seedTrack.videoId]))]
      if (tracks.length >= 4) return { tracks: dedupe(tracks).slice(0, want), source: 'ytmusic' }
    }
    // Otherwise fall through to the LLM path below.
  }

  // Prompt / genre / themed seed → YouTube Music (music-only, themed, fast). The LLM is the
  // fallback for open-ended prompts YT Music covers thinly.
  let resolved = await ytmusicMix(seed, want, exclude)
  let source: StationQueueResult['source'] = resolved.length ? 'ytmusic' : 'empty'

  if (!resolved.length) {
    const proposed = await llmTracklist(seed, want)
    resolved = proposed.length
      ? dedupe((await resolveTracks(proposed.map(t => ({ title: t.title, artist: t.artist })), 8)).filter(t => !exclude.has(t.videoId)))
      : []
    source = resolved.length ? 'llm' : 'empty'
  }

  // Backfill: if too few tracks, extend with a YouTube Music radio mix off the first hit.
  if (resolved.length && resolved.length < Math.min(want, 10)) {
    try {
      const mix = await ytmusicRadio(resolved[0]!.videoId)
      const already = new Set([...exclude, ...resolved.map(t => t.videoId)])
      const extra = fromYtmusic(mix, already)
      if (extra.length) {
        resolved = dedupe([...resolved, ...extra])
        source = 'mixed'
      }
    } catch (err) {
      logger.debug(`[stationEngine] backfill failed: ${String(err)}`)
    }
  }

  return { tracks: resolved.slice(0, want), source }
}

function dedupe(tracks: ResolvedTrack[]): ResolvedTrack[] {
  const seen = new Set<string>()
  const out: ResolvedTrack[] = []
  for (const t of tracks) {
    if (seen.has(t.videoId)) continue
    seen.add(t.videoId)
    out.push(t)
  }
  return out
}
