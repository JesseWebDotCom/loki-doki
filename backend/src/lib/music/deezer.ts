// Deezer is a keyless, CORS-open commercial music catalog. Unlike scraping YouTube Music search
// (which surfaces junk "artists" literally named after the query, sound-effect libraries, parodies,
// and hour-long compilations), every Deezer entry is a real, released recording with clean
// artist/title metadata. We use two things from it:
//
//   1. Editorial / curated PLAYLISTS — Deezer's in-house editors (and trusted curators like
//      Digster / Filtr) hand-build excellent themed playlists. These give us a high-fit, clean
//      tracklist for a concept ("80s synth-pop hits" → Deezer Pop Editor's "80s Hits").
//   2. Genre CHARTS — the current top tracks of a genre, for "what's hot now" stations.
//
// Everything Deezer returns is a song identity ({artist, title}); playback still happens through
// our YouTube resolver + stream proxy. This module only sources candidate song lists.

import { logger } from '@/lib/logger'

const BASE = 'https://api.deezer.com'

export interface DeezerTrack { title: string; artist: string; explicit?: boolean | null }

async function dz<T = any>(path: string, timeout = 9000): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) throw new Error(`deezer ${path} → ${res.status}`)
    return (await res.json()) as T
  } catch (err) {
    logger.debug(`[deezer] ${path} failed: ${String(err)}`)
    return null
  }
}

// Words too generic to prove a playlist actually matches the concept ("music", "hits", "the"…).
const STOP = new Set('the of a an and to for with music hits hit songs song mix best top playlist vol volume edition'.split(' '))
const toks = (s: string) => new Set((s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))

// Fisher–Yates in place. Used to vary the queue between tune-ins so a station doesn't replay the
// same head of the same editorial playlist every single time.
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j]!, arr[i]!] }
  return arr
}

// Deezer (especially soundtrack/various-artists playlists) often jams a credit into the title:
// "Eurythmics, Annie Lennox, Dave Stewart - Sweet Dreams", "Halle Bailey - Part of Your World",
// "We Don't Talk About Bruno By Carolina Gaitán/...". Strip a leading "<credit> - " when the credit
// before the first dash mentions the artist, and a trailing "By <...>" attribution. The resolver's
// own cleaner handles the usual promo junk afterwards.
function cleanDeezerTitle(title: string, artist: string): string {
  let t = title
  const dash = t.match(/^(.{0,80}?)\s[-–—]\s(.+)$/)
  if (dash) {
    const prefix = dash[1]!.toLowerCase()
    const a0 = (artist.toLowerCase().split(/[,/&]|feat|ft\.?| x /)[0] ?? '').trim()
    const firstWord = a0.split(/\s+/)[0] ?? ''
    if (firstWord.length > 1 && prefix.includes(firstWord)) t = dash[2]!.trim()
  }
  t = t.replace(/\s+by\s+[^()]+$/i, '').trim()   // "… By Artist/ Artist"
  return t || title
}
const meaningful = (s: Set<string>) => new Set([...s].filter((t) => t.length > 1 && !STOP.has(t)))

// Prefer professionally-curated playlists: editorial accounts, a sane size (not a 1,500-track dump
// or a 5-track sketch), and a title that overlaps the search concept.
function scorePlaylist(p: any, queryToks: Set<string>): number {
  const creator = (p?.user?.name ?? '').toLowerCase()
  let s = 0
  if (/\b(deezer|editor|digster|filtr|topsify|lofi girl)\b/.test(creator)) s += 6   // trusted curators
  const titleToks = toks(p?.title ?? '')
  for (const t of queryToks) if (titleToks.has(t)) s += 1
  const n = p?.nb_tracks ?? 0
  if (n >= 20 && n <= 300) s += 2
  else if (n > 800) s -= 2
  else if (n < 12) s -= 2
  return s
}

// Fit guard: the playlist title must share a MEANINGFUL word with the query. Without this, a niche
// concept with no real playlist ("90s Nickelodeon") silently grabs an unrelated editorial list
// ("80s Hits") on the curator bonus alone — the worst failure mode we saw in testing.
function fitsQuery(p: any, queryToks: Set<string>): boolean {
  const q = meaningful(queryToks)
  if (!q.size) return false
  const titleToks = toks(p?.title ?? '')
  for (const t of q) if (titleToks.has(t)) return true
  return false
}

/**
 * Find the best-fitting curated playlist for each query and merge their tracks (round-robin for
 * variety), deduped by artist+title. Returns up to `limit` candidate songs. Queries should be
 * concise music-search phrases ("90s grunge", "tarantino soundtrack"), not brand-y station names.
 */
export async function deezerPlaylistTracks(queries: string[], limit = 30, timeout = 9000): Promise<DeezerTrack[]> {
  const chosen: any[] = []
  const seenPlaylist = new Set<number>()
  for (const q of queries) {
    const data = await dz<{ data?: any[] }>(`/search/playlist?q=${encodeURIComponent(q)}&limit=8`, timeout)
    const qToks = toks(q)
    const ranked = (data?.data ?? [])
      .filter((p) => fitsQuery(p, qToks))                 // must actually match the concept
      .map((p) => ({ p, s: scorePlaylist(p, qToks) }))
      .sort((a, b) => b.s - a.s)
    // Don't always take the single top playlist — that makes every tune-in identical. Pick randomly
    // among the strongest fits (top score band), so a station rotates through the good editorial
    // playlists for its concept instead of replaying one. All candidates already passed fitsQuery.
    const positive = ranked.filter((r) => r.s > 0)
    if (positive.length) {
      const best = positive[0]!.s
      const band = positive.filter((r) => r.s >= best - 1 && !seenPlaylist.has(r.p.id)).slice(0, 4)
      const pick = band.length ? band[Math.floor(Math.random() * band.length)]! : positive[0]!
      if (!seenPlaylist.has(pick.p.id)) {
        seenPlaylist.add(pick.p.id)
        chosen.push(pick.p)
      }
    }
  }
  // Pull each chosen playlist's tracks. Shuffle each list so we sample ACROSS the whole editorial
  // playlist (often 50–300 tracks) rather than always returning its fixed top ~30 in order — the
  // other half of why stations felt static. Track order within an editorial playlist isn't a
  // quality signal, so shuffling costs nothing and adds a fresh mix every tune-in.
  const lists: DeezerTrack[][] = []
  for (const p of chosen) {
    const full = await dz<{ tracks?: { data?: any[] } }>(`/playlist/${p.id}`, timeout)
    const tracks = (full?.tracks?.data ?? [])
      .filter((t) => t?.title && t?.artist?.name)
      .map((t) => ({ title: cleanDeezerTitle(t.title as string, t.artist.name as string), artist: t.artist.name as string, explicit: typeof t.explicit_lyrics === 'boolean' ? t.explicit_lyrics : null }))
    if (tracks.length) lists.push(shuffle(tracks))
  }
  return roundRobin(lists, limit)
}

// Deezer genre ids (https://api.deezer.com/genre). chart/0 = the overall (all-genre) chart.
// Each pattern maps a phrase that may appear in a station prompt to a genre's chart id; checked in
// order, so put more specific genres first. Used to point a "what's hot now" station at the most
// relevant live chart instead of the generic global one.
const GENRE_CHART_PATTERNS: Array<[RegExp, number]> = [
  [/\breggaeton|perreo|dembow\b/i, 122],
  [/\bhip[- ]?hop|\brap\b|\btrap\b/i, 116],
  [/\br&b|\brnb\b|neo[- ]?soul\b/i, 165],
  [/\bsoul|funk|motown\b/i, 169],
  [/\bhouse|techno|\bedm\b|electronic|electro\b/i, 106],
  [/\bmetal|thrash|headbang/i, 464],
  [/\balternative|indie\b/i, 85],
  [/\bcountry\b/i, 84],
  [/\bclassical|symphon|composer/i, 98],
  [/\bjazz\b/i, 129],
  [/\bblues\b/i, 153],
  [/\breggae|roots|dub\b/i, 144],
  [/\bfolk|acoustic\b/i, 466],
  [/\blatin|salsa|bachata|cumbia\b/i, 197],
  [/\bdance\b/i, 113],
  [/\brock\b/i, 152],
  [/\bpop\b/i, 132],
]

function chartIdFor(text: string): number {
  for (const [re, id] of GENRE_CHART_PATTERNS) if (re.test(text)) return id
  return 0   // overall chart
}

async function chartTracksById(id: number, limit: number, timeout: number): Promise<DeezerTrack[]> {
  const data = await dz<{ data?: any[] }>(`/chart/${id}/tracks?limit=${Math.min(limit, 100)}`, timeout)
  return (data?.data ?? [])
    .filter((t) => t?.title && t?.artist?.name)
    .map((t) => ({ title: cleanDeezerTitle(t.title as string, t.artist.name as string), artist: t.artist.name as string, explicit: typeof t.explicit_lyrics === 'boolean' ? t.explicit_lyrics : null }))
}

/** The overall Deezer chart (top tracks across all genres) — for general "today's hits" stations. */
export async function deezerTopChart(limit = 30, timeout = 9000): Promise<DeezerTrack[]> {
  return chartTracksById(0, limit, timeout)
}

/**
 * Current top tracks from the live Deezer chart most relevant to a station's text. Picks a genre
 * chart when the prompt names a genre (e.g. "current rap hits" → the Rap/Hip-Hop chart), else the
 * overall chart. This is what gives chart-type stations genuinely up-to-date songs (the LLM has no
 * live chart knowledge).
 */
export async function deezerChartTracks(seedText: string, limit = 30, timeout = 9000): Promise<DeezerTrack[]> {
  return chartTracksById(chartIdFor(seedText), limit, timeout)
}

// ── Editorial genre radios ─────────────────────────────────────────────────────────
// Deezer's professionally maintained genre stations ("Rock Classics", "Hard Rock",
// "The '70s", "Motown", "Old School Hip Hop"…). Two properties make them the ideal
// grounding for our genre/decade stations: the pool is human-curated canon (no stock
// jam tracks, no fit guesses), and every /radio/{id}/tracks call returns a DIFFERENT
// randomized slice — so repeat tune-ins get variety for free.

let radioDirCache: { at: number; radios: { id: number; title: string; genre: string }[] } | null = null

async function radioDirectory(timeout: number): Promise<{ id: number; title: string; genre: string }[]> {
  if (radioDirCache && Date.now() - radioDirCache.at < 7 * 24 * 3600_000) return radioDirCache.radios
  const data = await dz<{ data?: any[] }>('/radio/genres', timeout)
  const radios: { id: number; title: string; genre: string }[] = []
  for (const g of data?.data ?? []) {
    for (const r of g?.radios ?? []) {
      if (r?.id && r?.title) radios.push({ id: r.id, title: String(r.title).trim(), genre: String(g.title ?? '').trim() })
    }
  }
  if (radios.length) radioDirCache = { at: Date.now(), radios }
  return radios
}

// Normalise a token for matching: lowercase (done by caller), strip surrounding apostrophes
// so Deezer's "The '80s" tokenises to "80s", and drop a trailing plural 's'. Decade forms
// collapse to a canonical NNs ("80s", "1980s"→"80s") so "80s"/"eighties"/"'80s" all agree.
function radioTok(raw: string): string {
  let t = raw.replace(/^['’]+|['’]+$/g, '')
  const decade = t.match(/^(?:19|20)?(\d0)s?$/)
  if (decade) return `${decade[1]}s`
  return t.replace(/s$/, '')
}
// Weighted token overlap between a station's text and a radio's title+genre. Filler words
// ("classic", "hits", "the"…) count half so "Classic Horror Themes" can't land on "Rock
// Classics" off the word 'classic' alone — a real genre/decade word must also match.
const WEAK_RADIO_TOKENS = new Set(['classic', 'the', 'hit', 'best', 'top', 'music', 'radio', 'school', 'old', 'theme', 'movie', 'film', 'score', 'soundtrack', 'song'])
function radioScore(seedToks: Set<string>, radio: { title: string; genre: string }): number {
  let score = 0
  for (const raw of `${radio.title} ${radio.genre}`.toLowerCase().split(/[^a-z0-9'’]+/)) {
    const t = radioTok(raw)
    if (!t || t.length < 2) continue
    if (seedToks.has(t)) score += WEAK_RADIO_TOKENS.has(t) ? 0.5 : 1
  }
  return score
}

/** Tracks from the Deezer editorial radios best matching a station's text — up to two radios,
 *  interleaved. Empty when no radio genuinely matches (niche/themed stations). */
export async function deezerRadioTracks(seedText: string, limit = 30, timeout = 9000): Promise<DeezerTrack[]> {
  const seedToks = new Set(
    seedText.toLowerCase().split(/[^a-z0-9'’]+/).map(radioTok).filter((t) => t.length >= 2),
  )
  const radios = await radioDirectory(timeout)
  const ranked = radios
    .map((r) => ({ r, score: radioScore(seedToks, r) }))
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
  if (!ranked.length) return []
  const lists = await Promise.all(ranked.map(async ({ r }) => {
    const data = await dz<{ data?: any[] }>(`/radio/${r.id}/tracks?limit=${Math.min(limit * 2, 40)}`, timeout)
    return (data?.data ?? [])
      .filter((t) => t?.title && t?.artist?.name)
      .map((t) => ({ title: cleanDeezerTitle(t.title as string, t.artist.name as string), artist: t.artist.name as string, explicit: typeof t.explicit_lyrics === 'boolean' ? t.explicit_lyrics : null }))
  }))
  return roundRobin(lists.filter((l) => l.length), limit)
}

// Interleave several lists so no single playlist dominates, deduping by normalized artist+title.
function roundRobin(lists: DeezerTrack[][], limit: number): DeezerTrack[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const out: DeezerTrack[] = []
  const seen = new Set<string>()
  const queues = lists.map((l) => [...l])
  let guard = 0
  while (out.length < limit && queues.some((q) => q.length) && guard++ < 10000) {
    for (const q of queues) {
      if (!q.length) continue
      const t = q.shift()!
      const k = `${norm(t.artist)}~${norm(t.title)}`
      if (k === '~' || seen.has(k)) continue
      seen.add(k)
      out.push(t)
      if (out.length >= limit) break
    }
  }
  return out
}

/** Artist photo from Deezer's CDN - fast, keyless, and near-complete coverage for any
 *  artist that charts. The genre-landing chips use this as their PRIMARY art (the
 *  MusicBrainz/Wikimedia path is authoritative but rate-limited to ~1 lookup/sec, which
 *  left half a chip row empty on first view). Exact-ish name match only. */
export async function deezerArtistPicture(name: string): Promise<string | null> {
  const n = name.trim()
  if (!n) return null
  const data = await dz<{ data?: Array<{ name?: string; picture_medium?: string; picture_big?: string }> }>(
    `/search/artist?q=${encodeURIComponent(n)}&limit=5`)
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const want = norm(n)
  const hit = (data?.data ?? []).find((a) => norm(a.name ?? '') === want)
  return hit?.picture_big ?? hit?.picture_medium ?? null
}

/** Album cover for a specific recording (artist + title) from Deezer's track search. */
export async function deezerTrackCover(artist: string, title: string): Promise<string | null> {
  const q = `artist:"${artist}" track:"${title}"`
  const data = await dz<{ data?: Array<{ album?: { cover_medium?: string; cover_big?: string } }> }>(
    `/search/track?q=${encodeURIComponent(q)}&limit=1`)
  const a = data?.data?.[0]?.album
  return a?.cover_big ?? a?.cover_medium ?? null
}
