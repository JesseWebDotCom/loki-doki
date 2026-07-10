// Music information proxy — Wikipedia artist summaries and MusicBrainz soundtrack lookups.
// MusicBrainz requires a User-Agent and rate-limits to 1 req/sec; we keep it simple
// and only call it when a track search is explicitly requested.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { getArtist, searchArtists, itunesSongArt, sameArtistName } from '@/lib/music/catalog'
import { getSongSmartLinks, getAlbumSmartLinks } from '@/lib/music/smartLinks'
import { musicPolicyFor, itunesSongAdvisory, lyricsHidden, OPEN_POLICY } from '@/lib/music/advisory'
import { deezerArtistPicture } from '@/lib/music/deezer'
import type { AppEnv } from '@/types'

export const musicInfo = new Hono<AppEnv>()
musicInfo.use('*', requireAuth)

const MB_UA = 'LokiDoki/3.0 (https://github.com/lokidoki; contact@lokidoki.app)'
const MB_BASE = 'https://musicbrainz.org/ws/2'
const WP_REST = 'https://en.wikipedia.org/api/rest_v1/page/summary'
const WP_API = 'https://en.wikipedia.org/w/api.php'
const WD_ENTITY = 'https://www.wikidata.org/wiki/Special:EntityData'
const COMMONS_FILEPATH = 'https://commons.wikimedia.org/wiki/Special:FilePath'

const wikiHeaders = { 'User-Agent': MB_UA, Accept: 'application/json' }

interface WikiSummary { title: string; description: string; extract: string; image: string | null; url: string | null }

async function wikipediaSummary(title: string): Promise<WikiSummary | null> {
  const res = await fetch(`${WP_REST}/${encodeURIComponent(title)}`, {
    headers: wikiHeaders,
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) return null
  const d = await res.json() as {
    type?: string
    title?: string
    description?: string
    extract?: string
    thumbnail?: { source?: string }
    content_urls?: { desktop?: { page?: string } }
  }
  if (d.type === 'disambiguation') return null
  return {
    title: d.title ?? title,
    description: d.description ?? '',
    extract: d.extract ?? '',
    image: d.thumbnail?.source ?? null,
    url: d.content_urls?.desktop?.page ?? null,
  }
}

// Wikidata P18 ("image") → a Wikimedia Commons thumbnail URL. This is the canonical, keyless way
// to get an artist's photo and works even when the Wikipedia article title doesn't match the
// MusicBrainz name (e.g. "Trouble" → "Trouble (band)") — MusicBrainz already disambiguated for us.
async function wikidataImage(qid: string): Promise<string | null> {
  try {
    const res = await fetch(`${WD_ENTITY}/${qid}.json`, { headers: wikiHeaders, signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const data = await res.json() as {
      entities?: Record<string, { claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: string } } }>> }>
    }
    const file = data.entities?.[qid]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value
    if (!file || typeof file !== 'string') return null
    return `${COMMONS_FILEPATH}/${encodeURIComponent(file)}?width=400`
  } catch {
    return null
  }
}

// Wikidata P154 ("logo image") → a Wikimedia Commons URL. A band's wordmark/logo, when one exists
// (not populated for every artist). Used to vary the generated album covers — some use the photo,
// some the logo, some both. Kept as a PNG (usually transparent) so it composites over art.
async function wikidataLogo(qid: string): Promise<string | null> {
  try {
    const res = await fetch(`${WD_ENTITY}/${qid}.json`, { headers: wikiHeaders, signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const data = await res.json() as {
      entities?: Record<string, { claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: string } } }>> }>
    }
    const file = data.entities?.[qid]?.claims?.P154?.[0]?.mainsnak?.datavalue?.value
    if (!file || typeof file !== 'string') return null
    return `${COMMONS_FILEPATH}/${encodeURIComponent(file)}?width=500`
  } catch {
    return null
  }
}

// Pull the article title out of an en.wikipedia.org/wiki/<Title> URL (the form MusicBrainz stores).
function titleFromWikipediaUrl(url: string | null): string | null {
  if (!url) return null
  try {
    const seg = new URL(url).pathname.split('/wiki/')[1]
    return seg ? decodeURIComponent(seg.replace(/_/g, ' ')) : null
  } catch {
    return null
  }
}

// Music-biased full-text search → summary of the best hit. Catches artists whose bare name is a
// disambiguation page or doesn't match an article title, when we have no MusicBrainz cross-ref.
async function wikipediaSearchSummary(name: string): Promise<WikiSummary | null> {
  try {
    const url = `${WP_API}?action=query&list=search&srsearch=${encodeURIComponent(`${name} musician band`)}` +
      `&srnamespace=0&srlimit=1&format=json&origin=*`
    const res = await fetch(url, { headers: wikiHeaders, signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const data = await res.json() as { query?: { search?: Array<{ title?: string }> } }
    const title = data.query?.search?.[0]?.title
    return title ? wikipediaSummary(title) : null
  } catch {
    return null
  }
}

// Confirm a Wikipedia page is actually about THIS musical act — not a same-named topic
// (the classic trap: the band "Europe" → the article on the continent, map image and all).
// Same posture as looksLikeSong below: trust Wikipedia's own short description / opening
// sentence to say it's music.
function looksLikeArtist(info: Pick<WikiSummary, 'description' | 'extract'>): boolean {
  const music = /\b(band|musician|singer|rapper|songwriter|composer|conductor|dj|disc jockey|music(al)? (?:group|duo|trio|project|artist|producer)|record producer|guitarist|vocalist|drummer|bassist|pianist|violinist|cellist|boy band|girl group|orchestra|ensemble|choir)\b/i
  return music.test(info.description ?? '') || music.test((info.extract ?? '').slice(0, 400))
}

// Resolve an artist photo + short bio. MusicBrainz identity leads (its editors already
// disambiguated "Europe" the band from Europe the continent), Wikipedia guessing is the
// fallback:
//   0. No mbid? Find one - MB's ranked artist search on the exact name.
//   1. MB "image" relation → direct Wikimedia Commons photo (curated, authoritative),
//      then Wikidata P18, then the MB-linked Wikipedia article for photo + bio.
//   2. Direct Wikipedia summary by name (+ standard "(band)"/"(musician)" titles),
//      accepted only when the page verifiably describes a musical act.
//   3. Music-biased Wikipedia search as a last resort (same verification + name match).
async function resolveArtistInfo(name: string, mbid: string | null): Promise<(WikiSummary & { found: true; logo: string | null }) | { found: false }> {
  let image: string | null = null
  let extract = ''
  let url: string | null = null
  let title = name
  let logo: string | null = null

  // 0a. PHOTO from Deezer's CDN first: fast, unthrottled, near-complete coverage.
  // Wikimedia Commons rate-limits bursts (verified live: one artist page's worth of
  // tiles got the whole IP 429'd and every photo vanished for the session), so the
  // Commons/Wikipedia chain below is the fallback for photos - and stays the source
  // of the bio, links, and band logo, which Deezer doesn't have.
  if (name) {
    try { image = await deezerArtistPicture(name) } catch { /* chain below */ }
  }

  // 0b. Recover the MusicBrainz identity when the caller only has a name (genre charts,
  // chart artists). Only trust exact name matches - a fuzzy hit would swap artists. Keep
  // ALL exact matches: several acts can share the exact name ("Skid Row" is both the US
  // and an Irish band) and only some carry images.
  let mbidCandidates: string[] = mbid ? [mbid] : []
  if (!mbid && name) {
    try {
      const hits = await searchArtists(name, 5)
      mbidCandidates = hits.filter(h => sameArtistName(h.name, name)).map(h => h.mbid).slice(0, 2)
    } catch { /* name-only fallbacks below */ }
  }

  // 1. MB path: image relation → Wikidata P18 → MB-linked Wikipedia article. Fills the
  // photo when Deezer missed, and the bio/link either way.
  for (const candidate of mbidCandidates) {
    if (image && extract) break
    try {
      const a = await getArtist(candidate)
      if (!a) continue
      if (!image && a.imageUrl) image = a.imageUrl
      if (!image && a.wikidataId) image = await wikidataImage(a.wikidataId)
      const wt = titleFromWikipediaUrl(a.wikipediaUrl)
      if (!extract && wt) {
        const s = await wikipediaSummary(wt)
        if (s) {
          if (!image) image = s.image
          extract = s.extract; url = s.url; title = s.title
        }
      }
      if (image && !mbid) { mbid = candidate }
    } catch { /* try the next candidate */ }
  }

  // 2. Wikipedia by name - and the article must be about music. Generic-name acts get the
  // standard disambiguated titles tried next - "Europe (band)" resolves directly.
  if ((!image || !extract) && name) {
    const direct = await wikipediaSummary(name)
    if (direct && looksLikeArtist(direct)) {
      if (!image) image = direct.image
      extract = extract || direct.extract; url = url ?? direct.url; title = direct.title
    } else if (!image) {
      for (const suffix of ['band', 'musician', 'singer', 'rapper']) {
        const s = await wikipediaSummary(`${name} (${suffix})`)
        if (s && looksLikeArtist(s)) { image = s.image; extract = extract || s.extract; url = url ?? s.url; title = s.title; break }
      }
    }
  }

  // 3. Last resort: music-biased full-text search - verified, AND the hit's title must
  // actually contain the artist's name (the search can rank a different musician first).
  if (!image && !extract && name) {
    const s = await wikipediaSearchSummary(name)
    if (s && looksLikeArtist(s) && s.title.toLowerCase().includes(name.toLowerCase())) {
      image = s.image; extract = s.extract; url = s.url; title = s.title
    }
  }

  // Band logo (Wikidata P154) — independent of the photo/bio above, so we get it even when the fast
  // Wikipedia path already filled those. getArtist is cached, so this is one Wikidata fetch/artist.
  if (mbid) {
    try {
      const a = await getArtist(mbid)
      if (a?.wikidataId) logo = await wikidataLogo(a.wikidataId)
    } catch { /* logo is optional */ }
  }

  if (!image && !extract) return { found: false }
  return { found: true, title, description: '', extract, image, url, logo }
}

// Confirm a Wikipedia page is actually about THIS song — not a same-named topic (the classic trap:
// "Columns" the song → the article on architectural columns). We check Wikipedia's own short
// description and the opening sentence for music wording, or that the artist is named in the blurb.
function looksLikeSong(info: { description?: string; extract?: string }, artist: string): boolean {
  const desc = (info.description ?? '').toLowerCase()
  const extract = (info.extract ?? '').toLowerCase()
  const a = artist.trim().toLowerCase()
  if (/\b(song|single|musical composition|instrumental|studio album|extended play)\b/.test(desc)) return true
  if (/\bis an?\b[^.]*\b(song|single|track|composition|instrumental|recording)\b/.test(extract)) return true
  // The artist is explicitly named in the summary — strong signal it's the right recording.
  if (a.length > 2 && /[a-z]/.test(a) && extract.includes(a)) return true
  return false
}

// GET /api/music/info/artist?q=ARTIST&mbid=MBID — artist photo + bio.
// The optional mbid unlocks the MusicBrainz → Wikidata → Wikimedia Commons path, which finds
// images the bare-name Wikipedia lookup misses (disambiguation pages, non-matching titles).
// GET /api/music/info/art?artist=X&title=Y — square album art for a song (iTunes, cached,
// artist-verified). The player/shelf art path for YouTube-sourced tracks whose 16:9 video
// thumbnails read as cheap in square tiles. A miss is 200 {url:null}, NOT 404 - "no art"
// is an expected answer (the caller keeps its fallback), and 404s paint the browser
// console red on every art-less tile.
musicInfo.get('/art', async (c) => {
  const artist = c.req.query('artist')?.trim() ?? ''
  const title = c.req.query('title')?.trim() ?? ''
  if (!artist || !title) return c.json({ error: 'artist and title required' }, 400)
  const url = await itunesSongArt(artist, title)
  // Browser-cacheable either way (misses too): tiles resolve with zero round trips on
  // repeat visits - the actual bytes are separately cached by the /api/img proxy.
  return c.json({ url: url ?? null }, 200, { 'Cache-Control': 'private, max-age=604800' })
})

musicInfo.get('/artist', async (c) => {
  const q = c.req.query('q')?.trim() ?? ''
  const mbid = c.req.query('mbid')?.trim() || null
  if (!q && !mbid) return c.json({ error: 'q required' }, 400)
  try {
    const info = await cachedLookup(
      'artist-info-v3', `${mbid ?? ''}|${q}`, THIRTY_DAYS_MS,
      () => resolveArtistInfo(q, mbid),
    )
    return c.json(info)
  } catch {
    return c.json({ found: false })
  }
})

// GET /api/music/info/track?artist=X&track=Y — MusicBrainz soundtrack appearances
// Returns movies/shows the recording appeared on so the frontend can deep-link.
musicInfo.get('/track', async (c) => {
  const artist = c.req.query('artist')?.trim()
  const track = c.req.query('track')?.trim()
  if (!track) return c.json({ appearances: [] })

  const qParts: string[] = []
  if (track) qParts.push(`recording:"${track}"`)
  if (artist) qParts.push(`artist:"${artist}"`)

  try {
    const url = `${MB_BASE}/recording/?query=${encodeURIComponent(qParts.join(' AND '))}&fmt=json&limit=3&inc=releases+release-groups`
    const res = await fetch(url, {
      headers: { 'User-Agent': MB_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return c.json({ appearances: [] })

    const data = await res.json() as {
      recordings?: Array<{
        releases?: Array<{
          title: string
          date?: string
          'release-group'?: {
            'primary-type'?: string
            'secondary-types'?: string[]
          }
        }>
      }>
    }

    const appearances: Array<{ title: string; year: string | null; type: 'movie' | 'show' | 'soundtrack' }> = []
    const seen = new Set<string>()

    for (const rec of data.recordings ?? []) {
      for (const rel of rec.releases ?? []) {
        const rg = rel['release-group']
        const primary = rg?.['primary-type'] ?? ''
        const secondary = rg?.['secondary-types'] ?? []
        const isSoundtrack = secondary.includes('Soundtrack') || primary === 'Soundtrack'
        if (!isSoundtrack) continue

        const title = rel.title.replace(/\s*\(Original.*?\)/i, '').trim()
        if (seen.has(title)) continue
        seen.add(title)

        const year = rel.date ? rel.date.slice(0, 4) : null
        // Heuristic: TV soundtracks often have "Season" / episode numbers in the title.
        const isShow = /season|vol\.|volume|episode|series/i.test(title)
        appearances.push({ title, year, type: isShow ? 'show' : 'movie' })
        if (appearances.length >= 12) break
      }
      if (appearances.length >= 12) break
    }

    return c.json({ appearances })
  } catch {
    return c.json({ appearances: [] })
  }
})

// GET /api/music/info/song?artist=X&title=Y — Wikipedia summary for a song (for the Now-Playing
// info panel). Tries the song page, then "artist song", then falls back to the artist.
musicInfo.get('/song', async (c) => {
  const artist = c.req.query('artist')?.trim() ?? ''
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ found: false })
  try {
    // Disambiguated page forms are inherently song articles, so accept them on sight. Wikipedia
    // uses "<Title> (<Artist> song)" and "<Title> (song)" exactly for this.
    const songForms = [artist ? `${title} (${artist} song)` : '', `${title} (song)`].filter(Boolean)
    for (const cand of songForms) {
      const info = await wikipediaSummary(cand)
      if (info?.extract) return c.json({ found: true, ...info })
    }
    // Bare title is ambiguous ("Columns" → architectural columns), so only accept it when the page
    // is clearly about a song / the artist is named in the blurb. And for COVERS the bare article
    // describes the original (Quiet Riot's "Cum On Feel the Noize" → Slade's article), so when we
    // know who's playing, require the summary to actually name them — a song article that only
    // credits someone else is the wrong recording's story.
    const info = await wikipediaSummary(title)
    const namesArtist = !artist
      || tokenOverlap(artist, info?.extract ?? '') >= Math.ceil(lyricTokens(artist).size / 2)
    if (info?.extract && looksLikeSong(info, artist) && namesArtist) return c.json({ found: true, ...info })
    return c.json({ found: false })
  } catch {
    return c.json({ found: false })
  }
})

// ── Lyrics (LRCLIB) ────────────────────────────────────────────────────────────────
// Free, keyless, open lyrics database with time-synced LRC. Cached hard (lyrics don't change).
export interface LyricLine { sec: number; text: string }
interface LyricsResult { synced: LyricLine[] | null; plain: string | null; source: string }

// Normalise a title/artist to comparable tokens: lowercase, drop parentheticals &
// "feat." tails, keep alphanumerics + CJK, split on whitespace.
function lyricTokens(s: string): Set<string> {
  const norm = (s ?? '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/feat\.?.*$/i, ' ')
    .replace(/[^a-z0-9぀-ヿ一-鿿]+/g, ' ')
  return new Set(norm.split(/\s+/).filter(Boolean))
}
// Count of shared tokens between two strings.
function tokenOverlap(a: string, b: string): number {
  const ta = lyricTokens(a), tb = lyricTokens(b)
  let n = 0
  for (const t of ta) if (tb.has(t)) n++
  return n
}
// Does an LRCLIB search hit actually correspond to the requested track? Requires the
// artist to share ≥half its tokens and the title to share ≥1 token — enough to reject
// unrelated songs (e.g. a random track that merely has lyrics) without being brittle.
function lyricHitMatches(reqArtist: string, reqTitle: string, hit: { trackName?: string | null; artistName?: string | null }): boolean {
  const artistTokens = lyricTokens(reqArtist)
  const artistOk = artistTokens.size === 0
    || tokenOverlap(reqArtist, hit.artistName ?? '') >= Math.ceil(artistTokens.size / 2)
  const titleOk = lyricTokens(reqTitle).size === 0 || tokenOverlap(reqTitle, hit.trackName ?? '') >= 1
  return artistOk && titleOk
}

// Popular songs often have a dozen+ LRCLIB uploads (reissues, compilations, region variants)
// with near-identical `duration` but meaningfully different line timing (different intro edit,
// re-recording, etc). Prefer whichever candidate's duration is closest to the track we're
// actually playing - it's not foolproof (two versions can share a duration to the second) but
// it's strictly better than taking the first fuzzy text match in whatever order LRCLIB returns.
function sortByDurationCloseness<T extends { duration?: number | null }>(items: T[], target?: number): T[] {
  if (!target) return items
  return [...items].sort((a, b) => {
    const da = typeof a.duration === 'number' ? Math.abs(a.duration - target) : Number.MAX_SAFE_INTEGER
    const db = typeof b.duration === 'number' ? Math.abs(b.duration - target) : Number.MAX_SAFE_INTEGER
    return da - db
  })
}

// Parse an LRC string ("[mm:ss.xx] words") into timestamped lines, dropping blank/timing-only ones.
function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const raw of lrc.split('\n')) {
    const matches = [...raw.matchAll(/\[(\d+):(\d+)(?:\.(\d+))?\]/g)]
    if (!matches.length) continue
    const text = raw.replace(/\[(\d+):(\d+)(?:\.(\d+))?\]/g, '').trim()
    for (const m of matches) {
      const min = parseInt(m[1]!, 10), s = parseInt(m[2]!, 10), frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0
      out.push({ sec: min * 60 + s + frac, text })
    }
  }
  return out.sort((a, b) => a.sec - b.sec)
}

async function fetchLrclib(artist: string, title: string, duration?: number): Promise<LyricsResult> {
  const headers = { 'User-Agent': MB_UA, Accept: 'application/json' }
  // Exact match endpoint first (best, includes duration disambiguation).
  try {
    const p = new URLSearchParams({ artist_name: artist, track_name: title })
    if (duration) p.set('duration', String(duration))
    const res = await fetch(`https://lrclib.net/api/get?${p}`, { headers, signal: AbortSignal.timeout(7000) })
    if (res.ok) {
      const d = await res.json() as { instrumental?: boolean; syncedLyrics?: string | null; plainLyrics?: string | null }
      if (d.syncedLyrics) return { synced: parseLrc(d.syncedLyrics), plain: d.plainLyrics ?? null, source: 'lrclib' }
      if (d.plainLyrics) return { synced: null, plain: d.plainLyrics, source: 'lrclib' }
      if (d.instrumental) return { synced: null, plain: null, source: 'instrumental' }
    }
  } catch { /* fall through to search */ }
  // Fuzzy search fallback. CRITICAL: only consider hits whose artist+title actually
  // match — LRCLIB search returns loosely-related rows, and a blind `find(has lyrics)`
  // happily grabs an unrelated song that happens to carry lyrics (e.g. instrumental
  // film scores getting a random vocal track's words).
  try {
    const res = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ artist_name: artist, track_name: title })}`,
      { headers, signal: AbortSignal.timeout(7000) })
    if (res.ok) {
      const arr = await res.json() as Array<{ trackName?: string | null; artistName?: string | null; duration?: number | null; instrumental?: boolean; syncedLyrics?: string | null; plainLyrics?: string | null }>
      const matches = arr.filter(x => lyricHitMatches(artist, title, x))
      // Some recordings (esp. film cues) are catalogued BOTH as instrumental and, by a
      // mistaken uploader, with a totally unrelated song's lyrics — at the same duration.
      // Distrust a lyric upload whose duration matches a known-instrumental copy: showing
      // nothing beats showing wrong lyrics.
      const instDurations = matches.filter(x => x.instrumental && typeof x.duration === 'number').map(x => x.duration as number)
      const trustworthy = (x: { duration?: number | null }) => !instDurations.some(d => Math.abs(d - (x.duration ?? -1e9)) <= 3)
      const ranked = sortByDurationCloseness(matches, duration)
      const synced = ranked.find(x => x.syncedLyrics && trustworthy(x))
      if (synced?.syncedLyrics) return { synced: parseLrc(synced.syncedLyrics), plain: synced.plainLyrics ?? null, source: 'lrclib' }
      const plain = ranked.find(x => x.plainLyrics && trustworthy(x))
      if (plain?.plainLyrics) return { synced: null, plain: plain.plainLyrics, source: 'lrclib' }
      // A genuine match exists but it's instrumental (or its only "lyrics" were untrusted) → show nothing, on purpose.
      if (matches.some(x => x.instrumental)) return { synced: null, plain: null, source: 'instrumental' }
    }
  } catch { /* give up */ }
  return { synced: null, plain: null, source: 'none' }
}

// Plain lyric TEXT for a track (one line per line), for the Studio forced-alignment job.
// Reuses the SAME cached lookup the /lyrics endpoint uses (identical namespace+key), so it's
// warm whenever the player has already shown lyrics. Returns null when LRCLIB has nothing.
export async function plainLyricsForAlign(artist: string, title: string, duration?: number): Promise<string | null> {
  const r = await cachedLookup<LyricsResult>(
    'lrclib', `${artist}|${title}|${duration ?? ''}`, THIRTY_DAYS_MS,
    () => fetchLrclib(artist, title, duration),
  )
  if (r.plain?.trim()) return r.plain
  if (r.synced?.length) { const t = r.synced.map(l => l.text).filter(Boolean).join('\n'); return t.trim() ? t : null }
  return null
}

// LRCLIB's own synced line timing for a track, for cross-checking against our forced
// alignment (see reconcileLyrics.ts). Same cached lookup/key as plainLyricsForAlign, so
// this is a free read whenever that's already warm. Null when LRCLIB has no synced lyrics.
export async function syncedLyricsForAlign(artist: string, title: string, duration?: number): Promise<LyricLine[] | null> {
  const r = await cachedLookup<LyricsResult>(
    'lrclib', `${artist}|${title}|${duration ?? ''}`, THIRTY_DAYS_MS,
    () => fetchLrclib(artist, title, duration),
  )
  return r.synced?.length ? r.synced : null
}

// GET /api/music/info/policy — the caller's music content-protection policy. The frontend
// uses maskTitles (censor titles in player surfaces) and explicit (whether to bother
// rendering 🅴 badges); enforcement itself is server-side.
musicInfo.get('/policy', async (c) => {
  const user = c.get('user')
  const policy = user ? await musicPolicyFor(user.id) : OPEN_POLICY
  return c.json(policy, 200, { 'Cache-Control': 'private, max-age=300' })
})

// GET /api/music/info/lyrics?artist=X&title=Y&duration=Z — synced (or plain) lyrics from LRCLIB.
// Content protections: profiles that hide explicit lyrics get {restricted:true} for
// explicit songs - and for unknowns too (fail-closed on the LYRICS surface only; the
// song itself still plays under a lenient profile).
musicInfo.get('/lyrics', async (c) => {
  const artist = c.req.query('artist')?.trim() ?? ''
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ synced: null, plain: null, source: 'none' })

  const user = c.get('user')
  if (user) {
    const policy = await musicPolicyFor(user.id)
    if (policy.lyrics === 'hide-explicit') {
      // A transient lookup failure reads as "unknown" - fail CLOSED on the lyrics surface.
      const advisory = await itunesSongAdvisory(artist, title).catch(() => null)
      if (lyricsHidden(policy, advisory)) return c.json({ synced: null, plain: null, source: 'none', restricted: true })
    }
  }

  const durationRaw = c.req.query('duration')
  const duration = durationRaw ? parseInt(durationRaw, 10) : undefined
  const result = await cachedLookup<LyricsResult>(
    'lrclib', `${artist}|${title}|${duration ?? ''}`, THIRTY_DAYS_MS,
    () => fetchLrclib(artist, title, duration),
  )
  return c.json(result)
})

// GET /api/music/info/soundtrack?title=SHOW_TITLE — Songs from a show/movie's soundtrack
musicInfo.get('/soundtrack', async (c) => {
  const title = c.req.query('title')?.trim()
  if (!title) return c.json({ songs: [] })

  try {
    const url = `${MB_BASE}/release/?query=release:"${encodeURIComponent(title)}"+secondary-type:Soundtrack&fmt=json&limit=5&inc=recordings`
    const res = await fetch(url, {
      headers: { 'User-Agent': MB_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return c.json({ songs: [] })

    const data = await res.json() as {
      releases?: Array<{
        title: string
        media?: Array<{
          tracks?: Array<{
            title: string
            length?: number
            recording?: { artist?: string }
          }>
        }>
      }>
    }

    const songs: Array<{ title: string; durationMs: number | null }> = []
    for (const release of data.releases ?? []) {
      if (!release.title.toLowerCase().includes(title.toLowerCase())) continue
      for (const medium of release.media ?? []) {
        for (const t of medium.tracks ?? []) {
          songs.push({ title: t.title, durationMs: t.length ?? null })
          if (songs.length >= 30) break
        }
        if (songs.length >= 30) break
      }
      if (songs.length) break
    }

    return c.json({ songs, sourceTitle: data.releases?.[0]?.title ?? title })
  } catch {
    return c.json({ songs: [] })
  }
})

// GET /api/music/info/smart-links?artist=&track= OR ?artist=&album=
// Returns cross-platform "Listen on …" links via iTunes + Odesli (keyless).
musicInfo.get('/smart-links', async (c) => {
  const artist = c.req.query('artist')?.trim() ?? ''
  const track  = c.req.query('track')?.trim()  ?? ''
  const album  = c.req.query('album')?.trim()  ?? ''
  if (!artist) return c.json({ links: [] })

  try {
    const links = track
      ? await getSongSmartLinks(artist, track)
      : album
        ? await getAlbumSmartLinks(artist, album)
        : []
    return c.json({ links })
  } catch {
    return c.json({ links: [] })
  }
})
