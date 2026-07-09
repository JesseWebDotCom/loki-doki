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
import { getModel, getFastModel } from '@/lib/models'
import { ytmusicRadio, ytmusicSearch } from '@/lib/youtube/ytmusic'
import { resolveTrack, resolveTracks, cleanTrackTitle, type ResolvedTrack } from '@/lib/music/resolve'
import { deezerPlaylistTracks, deezerChartTracks, type DeezerTrack } from '@/lib/music/deezer'
import { isJunkTrack, dropJunk } from '@/lib/music/junk'
import { preferLibrary } from '@/lib/music/resolveSource'
import { upsertAdvisory } from '@/lib/music/advisory'
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
    // Concept → search terms is a small, mechanical task — use the fast (router) model so this
    // doesn't sit on the tune-in critical path behind a big-model generation.
    const model = await getFastModel()
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

async function ytmusicMix(seed: StationSeed, want: number, exclude: Set<string>, queries: string[]): Promise<ResolvedTrack[]> {
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
      if (isJunkTrack(t.title, t.author ?? '')) continue   // drop sfx/type-beat/compilation junk
      seen.add(t.videoId); out.push(toResolved(t)); added++
    }
  }
  // Extend with a YouTube Music radio mix off the top hit, for length + per-tune-in variety.
  if (out.length && out.length < want) {
    for (const t of await ytmusicRadio(out[0]!.videoId)) {
      if (out.length >= want) break
      if (!t.videoId || seen.has(t.videoId)) continue
      if (isJunkTrack(t.title, t.author ?? '')) continue
      seen.add(t.videoId); out.push(toResolved(t))
    }
  }
  return shuffle(out).slice(0, want)
}

/** Concise music-search queries for a seed: LLM-derived when possible, else the raw name/prompt. */
// The station's own words as plain search queries — no LLM. Used as the fallback when query
// generation yields nothing, and as the FAST path so the first track never waits on an LLM call.
function rawQueriesFor(seed: StationSeed): string[] {
  return [seed.name, seed.aiPrompt].filter((q): q is string => !!q && q.trim().length > 1).map(q => q.slice(0, 90).trim())
}

async function searchQueriesFor(seed: StationSeed): Promise<string[]> {
  const queries = await llmSearchQueries(seed)
  if (queries.length) return queries
  return rawQueriesFor(seed)
}

const FIT_SCHEMA = {
  type: 'object',
  properties: { drop: { type: 'array', items: { type: 'integer' } } },
  required: ['drop'],
} as const

/** LLM fit pass: drop candidates that clearly don't belong on this station. The catalog
 *  sources are honest about being SONGS but sloppy about CONCEPT - Deezer's "hair metal"
 *  playlists happily include Careless Whisper - and only a judgment call can catch that.
 *  Fast model, fail-open (any error keeps the list), and never guts the queue: if the
 *  model rejects most of the list, trust the sources over the judge. */
const FIT_BATCH = 10   // small batches keep the fast (3B) judge sharp; long lists dilute it

async function llmFitFilter(seed: StationSeed, tracks: ResolvedTrack[], opts?: { fast?: boolean }): Promise<ResolvedTrack[]> {
  if (tracks.length < 5) return tracks
  try {
    // Music knowledge is the whole job here (does the 3B model KNOW Wes Montgomery is
    // jazz?). Full builds run in the background, so they get the main model's broader
    // knowledge; only the latency-critical fast tune-in path uses the small judge.
    const model = opts?.fast ? await getFastModel() : await getModel()
    const sys = 'You are a strict radio-station music director. Given a station concept and a numbered ' +
      'candidate list, reply with JSON {"drop":[numbers]} for songs that do not fit the station\'s ' +
      'genre, era, or theme. Judge well-known songs by what they ACTUALLY are: famous pop, soul, ' +
      'soft-rock, reggae, disco, or schlager songs never belong on a rock/metal station no matter ' +
      'what playlist they came from. Keep genre-adjacent picks; keep songs you do not recognize. JSON only.'

    const judgeBatch = async (batch: ResolvedTrack[]): Promise<ResolvedTrack[]> => {
      const list = batch.map((t, i) => `${i}. ${t.artist || '?'} — ${t.title}`).join('\n')
      const user = `Station: "${seed.name ?? ''}" — ${seed.aiPrompt}\n\nCandidates:\n${list}`
      const chat = await ollamaChat(model, [{ role: 'system', content: sys }, { role: 'user', content: user }], [], { temperature: 0.1, num_predict: 200 }, FIT_SCHEMA)
      const parsed = JSON.parse(chat.message?.content?.trim() || '{}') as { drop?: number[] }
      const drop = new Set((parsed.drop ?? []).filter(n => Number.isInteger(n) && n >= 0 && n < batch.length))
      return batch.filter((_, i) => !drop.has(i))
    }

    const batches: ResolvedTrack[][] = []
    for (let i = 0; i < tracks.length; i += FIT_BATCH) batches.push(tracks.slice(i, i + FIT_BATCH))
    const kept = (await Promise.all(batches.map(b => judgeBatch(b).catch(() => b)))).flat()

    // No keep-at-least-N guard here: a heavy drop is a SIGNAL, not a judge error. The
    // caller reads it as "the catalog sources missed this concept" and falls back to the
    // LLM tracklist (verified live: 'classic horror themes' gets Hamilton from Deezer).
    if (kept.length < tracks.length) {
      logger.debug(`[stationEngine] fit filter dropped ${tracks.length - kept.length}/${tracks.length} for "${seed.name}"`)
    }
    return kept
  } catch (err) {
    logger.debug(`[stationEngine] fit filter failed (kept all): ${String(err)}`)
    return tracks
  }
}

// "What's hot right now" stations should be seeded from a LIVE chart, since the LLM (and even a
// curated playlist) lags the real-time charts. Detect that intent from the station name/prompt.
const CHART_INTENT_RE =
  /\b(charts?|charting|right now|this year|this week|this month|trending|going viral|viral|dominating|of[- ]the[- ]moment|hottest|biggest (?:songs|hits)|this decade|2020s|today'?s hits|on the radio)\b/i
function isChartStation(seed: StationSeed): boolean {
  return CHART_INTENT_RE.test(`${seed.name ?? ''} ${seed.aiPrompt}`)
}

// Deezer knows which songs are explicit - bank that verdict against the resolved
// YouTube ref (correlated by normalized identity) so the content-protection layer
// gets advisory data for free with every station build. Fire-and-forget.
function bankDeezerAdvisories(candidates: DeezerTrack[], resolved: ResolvedTrack[]): void {
  const key = (t: { title: string; artist: string }) => `${t.artist}|${t.title}`.toLowerCase().replace(/[^a-z0-9|]/g, '')
  const byKey = new Map(candidates.filter(c => typeof c.explicit === 'boolean').map(c => [key(c), c.explicit as boolean]))
  for (const r of resolved) {
    const explicit = byKey.get(key(r))
    if (explicit === undefined) continue
    void upsertAdvisory(r.videoId, explicit ? 1 : 0, 'deezer', { title: r.title, artist: r.artist })
  }
}

/** Live Deezer chart (genre-targeted when the prompt names a genre) resolved to YouTube and
 *  junk-filtered — the freshest source for chart-type stations. */
async function chartMix(seed: StationSeed, want: number, exclude: Set<string>): Promise<ResolvedTrack[]> {
  const chart = (await deezerChartTracks(`${seed.name ?? ''} ${seed.aiPrompt}`, want * 2)).slice(0, want + 6)
  if (!chart.length) return []
  const resolved = await resolveTracks(chart.map(t => ({ title: t.title, artist: t.artist })), 8)
  bankDeezerAdvisories(chart, resolved)
  return dropJunk(resolved).filter(t => !exclude.has(t.videoId))
}

/** Deezer curated-playlist tracks resolved to YouTube, junk-filtered. The cleanest, highest-fit
 *  source for genre/decade/mood/theme stations — every entry is a real released recording. */
async function deezerMix(queries: string[], want: number, exclude: Set<string>): Promise<ResolvedTrack[]> {
  if (!queries.length) return []
  // Unlike YouTube Music (videoIds in hand), Deezer tracks must each be resolved to a YouTube id.
  // Resolve only a small buffer beyond `want` so a cold tune-in stays fast; misses are cheap to
  // backfill from the YT Music tier. (Resolutions are cached permanently, so repeats are instant.)
  const candidates = (await deezerPlaylistTracks(queries, want * 2)).slice(0, want + 6)
  if (!candidates.length) return []
  const resolved = await resolveTracks(candidates.map(t => ({ title: t.title, artist: t.artist })), 8)
  bankDeezerAdvisories(candidates, resolved)
  return dropJunk(resolved).filter(t => !exclude.has(t.videoId))
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
export async function llmTracklist(seed: StationSeed, want: number): Promise<Array<{ artist: string; title: string }>> {
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
export async function buildStationQueue(seed: StationSeed, opts?: { fast?: boolean }): Promise<StationQueueResult> {
  // Fast mode builds just enough to START PLAYING (the caller fills the rest in the background),
  // so a tune-in resolves the first track in ~one round-trip instead of building a full queue.
  const fast = opts?.fast ?? false
  const want = fast
    ? Math.min(Math.max(seed.count ?? 3, 1), 4)
    : Math.min(Math.max(seed.count ?? 24, 6), 100)
  const exclude = new Set(seed.excludeVideoIds ?? [])

  // Known videoId → ride YouTube Music's radio mix off it directly (no resolve, no LLM). This is
  // the fast path behind "play this exact song now".
  if (seed.seedVideoId) {
    const mix = await ytmusicRadio(seed.seedVideoId)
    const tracks = dropJunk(fromYtmusic(mix, exclude))
    if (tracks.length) return { tracks: await preferLibrary(dedupe(tracks).slice(0, want)), source: 'ytmusic' }
  }

  // Artist / song seed → resolve the seed, then ride YouTube Music's curated radio mix,
  // interleaved with sound-nearest library tracks when the ML sound engine knows the seed.
  if ((seed.seedType === 'artist' || seed.seedType === 'song') && seed.seedValue) {
    const seedTrack = await resolveTrack(seed.seedType === 'song'
      ? { title: seed.seedValue, artist: '' }
      : { title: '', artist: seed.seedValue })
    if (seedTrack) {
      const mix = await ytmusicRadio(seedTrack.videoId)
      const candidates = await interleaveSoundalikes(seedTrack.videoId,
        dropJunk(fromYtmusic(mix, new Set([...exclude, seedTrack.videoId]))), exclude)
      const tracks = [seedTrack, ...candidates]
      if (tracks.length >= 4) return { tracks: await preferLibrary(dedupe(tracks).slice(0, want)), source: 'ytmusic' }
    }
    // Otherwise fall through to the LLM path below.
  }

  // Prompt / genre / themed seed → quality-ordered hybrid (see module header). Each tier is
  // junk-filtered and song-deduped; we stop once we have a full queue.
  //   1. Deezer curated playlists — cleanest, highest-fit; covers most genre/decade/mood/theme stations.
  //   2. YouTube Music search   — broad coverage fallback for niche stations Deezer has no playlist for
  //                               (TV themes, VGM, chiptune); now junk-filtered.
  //   3. LLM tracklist          — last resort when the catalog sources come up thin.
  // Testing showed no single source wins across all station types, but this order gives near-zero
  // junk with full coverage. (harness: Deezer 0% junk / YT-only 6.3% junk / LLM-only 60% coverage.)
  // Always use refined search queries (now on the warm fast model, ~1s) — even in fast mode — so
  // the first tracks actually FIT the station. Raw natural-language queries (the station name /
  // description) make YouTube Music return off-target songs, which is why "Up Next" looked wrong.
  const queries = await searchQueriesFor(seed)
  let source: StationQueueResult['source'] = 'empty'
  let resolved: ResolvedTrack[] = []

  // FAST first-track path: a single YouTube Music search returns playable videoIds DIRECTLY — no
  // Deezer round-trip and no per-track resolve (each of which is a separate network hop). This is
  // the same "one search, then play" that makes a normal YouTube video start instantly; the
  // background full build handles curation/quality for the rest of the queue.
  if (fast) {
    // Fetch a small surplus so the fit pass below has room to drop misfits and still
    // hand back a full fast queue - the FIRST song is the one a bad fit hurts most.
    const yt = dropJunk(await ytmusicMix(seed, want + 3, exclude, queries))
    let picked = yt
    if (!isChartStation(seed)) {
      const judged = await llmFitFilter(seed, dedupe(yt), { fast: true })
      // A judge that rejects everything can't stall the tune-in - play the sources' best
      // and let the full background build (with its LLM fallback) correct the queue.
      picked = judged.length ? judged : yt
    }
    return { tracks: await preferLibrary(dedupe(picked).slice(0, want)), source: picked.length ? 'ytmusic' : 'empty' }
  }

  // Tier 0: live chart for "what's hot now" stations (today's hits, viral, trending, this-year…).
  // Seed roughly half the queue from the chart so it stays current, then let the curated tier add
  // breadth. Skipped for evergreen genre/decade/mood stations.
  if (isChartStation(seed)) {
    const chart = dedupe(await chartMix(seed, Math.ceil(want / 2) + 2, exclude))
    if (chart.length) { resolved = chart; source = 'mixed' }
  }

  // Tier 0.5: owned-library sound tier — analyzed library tracks whose classifier tags
  // (hard rock, mood/energetic…) appear in the station's own name/prompt. Capped to a
  // third of the queue so it seasons the station with music the household owns without
  // drowning out discovery. Cold start (no analyzed tracks) contributes 0.
  if (resolved.length < want) {
    try {
      const { libraryTracksForText } = await import('@/lib/music/similarity')
      const already = new Set([...exclude, ...resolved.map(t => t.videoId)])
      const lib = (await libraryTracksForText(`${seed.name ?? ''} ${seed.aiPrompt}`, Math.ceil(want / 3)))
        .filter(t => !already.has(t.ref) && (t.title || t.artist))
        .map(t => ({ videoId: t.ref, title: t.title ?? '', artist: t.artist ?? '', durationSec: null, score: 1 }))
      if (lib.length) resolved = dedupe([...resolved, ...lib])
    } catch { /* intel not installed */ }
  }

  // Tier 1: Deezer curated.
  if (resolved.length < want) {
    const already = new Set([...exclude, ...resolved.map(t => t.videoId)])
    const dz = await deezerMix(queries, want - resolved.length, already)
    if (dz.length) resolved = dedupe([...resolved, ...dz])
  }
  if (resolved.length) source = 'mixed'

  // Tier 2: YouTube Music search (junk-filtered) to fill remaining slots / cover niche concepts.
  if (resolved.length < want) {
    const already = new Set([...exclude, ...resolved.map(t => t.videoId)])
    const yt = await ytmusicMix(seed, want - resolved.length, already, queries)
    if (yt.length) { resolved = dedupe([...resolved, ...yt]); source = source === 'empty' ? 'ytmusic' : 'mixed' }
  }

  // Fit pass over the catalog candidates. A heavy drop is the tell that the sources
  // missed the CONCEPT (themed/soundtrack stations: 'classic horror themes' pulls
  // Hamilton numbers from Deezer) - that flips the LLM tracklist from last resort to
  // lead source below.
  let sourcesUnreliable = false
  if (!isChartStation(seed) && resolved.length) {
    const before = dedupe(resolved)
    const judged = await llmFitFilter(seed, before)
    sourcesUnreliable = judged.length < Math.max(3, Math.ceil(before.length / 2))
    resolved = judged
  }

  // LLM tracklist: last resort when the catalog tiers came up thin - and the LEAD source
  // when the fit judge rejected most of what they returned. The model actually KNOWS what
  // belongs on a themed station (Halloween theme, Tubular Bells); the resolver's confidence
  // floor guards against hallucinated picks.
  if (!fast && (sourcesUnreliable || resolved.length < Math.min(want, 8))) {
    const proposed = await llmTracklist(seed, want)
    if (proposed.length) {
      const already = new Set([...exclude, ...resolved.map(t => t.videoId)])
      const more = dropJunk(await resolveTracks(proposed.map(t => ({ title: t.title, artist: t.artist })), 8)).filter(t => !already.has(t.videoId))
      // Concept-fit LLM picks LEAD; surviving catalog tracks fill in behind them.
      if (more.length) { resolved = dedupe([...more, ...resolved]); source = source === 'empty' ? 'llm' : 'mixed' }
    }
  }

  // Length backfill: if still short, extend with a YouTube Music radio mix off the first hit.
  // Skipped in fast mode (length doesn't matter for the first track; the background build fills it).
  if (!fast && resolved.length && resolved.length < Math.min(want, 10)) {
    try {
      const mix = await ytmusicRadio(resolved[0]!.videoId)
      const already = new Set([...exclude, ...resolved.map(t => t.videoId)])
      const extra = dropJunk(fromYtmusic(mix, already))
      if (extra.length) { resolved = dedupe([...resolved, ...extra]); source = 'mixed' }
    } catch (err) {
      logger.debug(`[stationEngine] backfill failed: ${String(err)}`)
    }
  }

  // (The fit pass already ran above, before the LLM tier - LLM picks and the radio
  // backfill riding off them are concept-fit by construction.)

  // Cap repeats per artist (≤3) only when we have comfortable surplus, so variety improves without
  // starving a thin niche queue.
  const finalTracks = resolved.length > want + 3 ? capPerArtist(dedupe(resolved), 3) : dedupe(resolved)
  return { tracks: await preferLibrary(finalTracks.slice(0, want)), source }
}

/** Music-intelligence tier for song/artist seeds: interleave the catalog mix ~50/50 with
 *  sound-nearest tracks from the household's analyzed library (discogs-effnet embeddings).
 *  Gated on a meaningful search space (≥50 analyzed tracks) so a cold start contributes 0
 *  and the behavior is exactly the catalog mix. Library refs (local:/plex:/yt) ride the
 *  queue's videoId ref carrier; they're owned tracks, so no junk filter needed. */
async function interleaveSoundalikes(seedRef: string, mix: ResolvedTrack[], exclude: Set<string>): Promise<ResolvedTrack[]> {
  try {
    const { featureCount, nearestByRef } = await import('@/lib/music/similarity')
    if (await featureCount() < 50) return mix
    const near = await nearestByRef(seedRef, Math.max(4, Math.ceil(mix.length / 2)), { maxPerArtist: 2 })
    const extras: ResolvedTrack[] = near
      .filter(n => !exclude.has(n.ref) && (n.title || n.artist))
      .map(n => ({ videoId: n.ref, title: n.title ?? '', artist: n.artist ?? '', durationSec: null, score: n.similarity }))
    if (!extras.length) return mix
    const out: ResolvedTrack[] = []
    const max = Math.max(mix.length, extras.length)
    for (let i = 0; i < max; i++) {
      if (i < mix.length) out.push(mix[i]!)
      if (i < extras.length) out.push(extras[i]!)
    }
    return out
  } catch { return mix }
}

// Identity key for "the same song" regardless of which upload it is. The same recording often
// appears under several videoIds (official audio, lyric video, a re-upload), so deduping on
// videoId alone leaves a station playing the same track twice. Collapse on normalized
// artist+title too; fall back to title-only when the artist is unknown.
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
function songKey(t: ResolvedTrack): string {
  const title = normKey(t.title)
  if (!title) return ''
  const artist = normKey(t.artist)
  return artist ? `${artist}~${title}` : title
}

// Keep at most `max` tracks per artist so one artist (or a cover band that slipped the junk filter)
// can't dominate a station. Order-preserving.
function capPerArtist(tracks: ResolvedTrack[], max: number): ResolvedTrack[] {
  const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const count = new Map<string, number>()
  const out: ResolvedTrack[] = []
  for (const t of tracks) {
    const a = norm(t.artist)
    if (!a) { out.push(t); continue }
    const n = (count.get(a) ?? 0) + 1
    if (n > max) continue
    count.set(a, n)
    out.push(t)
  }
  return out
}

function dedupe(tracks: ResolvedTrack[]): ResolvedTrack[] {
  const seenIds = new Set<string>()
  const seenSongs = new Set<string>()
  const out: ResolvedTrack[] = []
  for (const t of tracks) {
    if (seenIds.has(t.videoId)) continue
    const sk = songKey(t)
    if (sk && seenSongs.has(sk)) continue
    seenIds.add(t.videoId)
    if (sk) seenSongs.add(sk)
    out.push(t)
  }
  return out
}
