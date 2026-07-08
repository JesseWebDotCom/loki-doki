// MusicBrainz + Cover Art Archive catalog layer. This is the app's identity graph:
// artist → release-group (album) → recording (song), keyed by stable MBIDs. The audio
// itself lives on YouTube (see resolve.ts) — this module never touches playback, only
// metadata, browse, and search.
//
// MusicBrainz is strict: a descriptive User-Agent is mandatory and requests are limited to
// ~1/second. We honour that with a tiny serialized throttle (mbFetch) AND cache every result
// hard via cachedLookup (catalog data is effectively static), so browse-heavy UIs almost
// never hit the live API twice for the same thing.

import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { logger } from '@/lib/logger'

const MB_BASE = 'https://musicbrainz.org/ws/2'
const MB_UA = 'LokiDoki/3.0 (https://github.com/lokidoki; contact@lokidoki.app)'
const CAA_BASE = 'https://coverartarchive.org'

// ── Public shapes ────────────────────────────────────────────────────────────────

export interface CatalogArtist {
  mbid: string
  name: string
  disambiguation: string | null   // e.g. "UK rock band" — disambiguates same-named artists
  type: string | null             // Person | Group | …
  country: string | null
}

export interface CatalogAlbum {
  mbid: string                     // release-group MBID
  title: string
  primaryType: string | null      // Album | Single | EP | …
  secondaryTypes: string[]        // Soundtrack | Live | Compilation | …
  firstReleaseDate: string | null
  year: number | null
  artistName: string
  artistMbid: string | null
  coverUrl: string | null         // Cover Art Archive front image (constructed, may 404)
}

export interface CatalogSong {
  mbid: string                     // recording MBID
  title: string
  durationSec: number | null
  artistName: string
  artistMbid: string | null
  albumTitle: string | null
  albumMbid: string | null        // release-group MBID, for cover art
}

export interface CatalogArtistDetail extends CatalogArtist {
  wikipediaUrl: string | null
  wikidataId: string | null
  officialUrl: string | null
  tags: string[]
}

// ── Rate-limited fetch ───────────────────────────────────────────────────────────

// Serialize all MusicBrainz calls through a single promise chain with >=1100ms spacing.
// Combined with the 30-day cache this keeps us comfortably under the 1 req/sec ceiling even
// when many users browse at once.
let mbChain: Promise<unknown> = Promise.resolve()
let lastCall = 0

function mbFetch(path: string, timeout = 8000): Promise<any> {
  const run = async (): Promise<any> => {
    const wait = 1100 - (Date.now() - lastCall)
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastCall = Date.now()
    const url = `${MB_BASE}${path}${path.includes('?') ? '&' : '?'}fmt=json`
    const res = await fetch(url, {
      headers: { 'User-Agent': MB_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeout),
    })
    if (!res.ok) throw new Error(`musicbrainz ${res.status} for ${path}`)
    return res.json()
  }
  // Chain so calls run strictly one-at-a-time; a failure doesn't break the chain.
  const next = mbChain.then(run, run)
  mbChain = next.catch(() => {})
  return next
}

const yearOf = (date: string | null | undefined): number | null => {
  const y = date ? parseInt(date.slice(0, 4), 10) : NaN
  return Number.isFinite(y) ? y : null
}

const lucene = (s: string) => s.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').trim()

/** Cover Art Archive front image for a release-group. Constructed, not probed — the URL
 *  302s to the real image or 404s when there's no art, which `<img>` handles gracefully. */
export function albumCoverUrl(releaseGroupMbid: string, size: 250 | 500 | 1200 = 500): string {
  return `${CAA_BASE}/release-group/${releaseGroupMbid}/front-${size}`
}

/** Fallback cover art from the iTunes Search API (keyless) for albums the Cover Art Archive has no
 *  image for — common for live bootlegs / broadcast releases. Only called when the CAA image 404s,
 *  and cached hard (misses included, so a coverless album isn't re-searched). Returns null when
 *  iTunes has nothing either. */
export async function itunesAlbumCover(artist: string, album: string): Promise<string | null> {
  const a = artist.trim()
  const al = album.trim()
  // The artist is REQUIRED — iTunes' fuzzy search happily returns another artist's album (a Guns N'
  // Roses bootleg query matched a BLACKPINK release), so without an artist to verify against we'd
  // risk showing the wrong cover, which is worse than a blank tile.
  if (!al || !a) return null
  return cachedLookup('itunes-album-cover', `${a}~${al}`, THIRTY_DAYS_MS, async () => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    const want = norm(a)
    const artistMatches = (name: string) => {
      const r = norm(name)
      return !!r && (r === want || (r.length >= 5 && want.includes(r)) || (want.length >= 5 && r.includes(want)))
    }
    // Bootlegs bury the real title under venues/dates/"broadcast"; try the title as-is, then a
    // de-noised version. Artist verification below guards against the wrong-artist matches that
    // aggressive title-cleaning would otherwise invite.
    const cleaned = al.replace(/[([].*?[)\]]/g, ' ').replace(/[,:].*$/, ' ')
      .replace(/\b(remaster(?:ed)?|deluxe|expanded|edition|live|broadcast|bootleg|anniversary|reissue|mono|stereo)\b/gi, ' ')
      .replace(/\b(?:19|20)\d\d\b/g, ' ').replace(/\s+/g, ' ').trim()
    const queries = [...new Set([al, cleaned].filter(q => q.length > 1))]
    try {
      for (const q of queries) {
        const term = encodeURIComponent(`${a} ${q}`.trim())
        const res = await fetch(`https://itunes.apple.com/search?term=${term}&entity=album&media=music&limit=8`, {
          headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000),
        })
        if (!res.ok) continue
        const data = await res.json() as { results?: Array<{ artworkUrl100?: string; artistName?: string; collectionName?: string }> }
        // Require BOTH the artist AND the album title to match — a same-artist but wrong-album hit
        // (a bootleg fuzzy-matching a real single) would otherwise show the wrong cover. Only take
        // art we're confident is this exact release; otherwise leave the tile blank.
        const qKey = norm(q)
        const hit = (data.results ?? []).find(r => {
          if (!r.artworkUrl100 || !artistMatches(r.artistName ?? '')) return false
          const rt = norm(r.collectionName ?? '')
          return !!rt && !!qKey && (rt.includes(qKey) || qKey.includes(rt))
        })
        // Apple returns a 100px thumbnail; swap the size segment for a crisp grid-sized image.
        if (hit?.artworkUrl100) return hit.artworkUrl100.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.$1')
      }
      return null
    } catch (err) {
      logger.debug(`[catalog] itunesAlbumCover failed: ${String(err)}`)
      return null
    }
  })
}

// ── Search ───────────────────────────────────────────────────────────────────────

export async function searchArtists(query: string, limit = 12): Promise<CatalogArtist[]> {
  const q = query.trim()
  if (!q) return []
  return cachedLookup('mb-artist-search', `${q}:${limit}`, THIRTY_DAYS_MS, async () => {
    try {
      const data = await mbFetch(`/artist?query=${encodeURIComponent(lucene(q))}&limit=${limit}`)
      return (data.artists ?? []).map((a: any): CatalogArtist => ({
        mbid: a.id,
        name: a.name,
        disambiguation: a.disambiguation || null,
        type: a.type || null,
        country: a.country || null,
      }))
    } catch (err) {
      logger.debug(`[catalog] searchArtists failed: ${String(err)}`)
      return []
    }
  })
}

export async function searchAlbums(query: string, limit = 16): Promise<CatalogAlbum[]> {
  const q = query.trim()
  if (!q) return []
  return cachedLookup('mb-album-search', `${q}:${limit}`, THIRTY_DAYS_MS, async () => {
    try {
      const data = await mbFetch(`/release-group?query=${encodeURIComponent(lucene(q))}&limit=${limit}`)
      return (data['release-groups'] ?? []).map(mapReleaseGroup)
    } catch (err) {
      logger.debug(`[catalog] searchAlbums failed: ${String(err)}`)
      return []
    }
  })
}

// Search recordings. With `artist` set, builds a fielded Lucene query
// (`recording:(title) AND artist:(band)`) so results are scoped to that band — otherwise a
// bare title match returns hundreds of covers/versions. `lucene()` strips Lucene operators
// from each value, so wrapping the cleaned words in `field:( … )` is injection-safe.
export async function searchSongs(query: string, limit = 20, artist?: string): Promise<CatalogSong[]> {
  const q = query.trim()
  const a = (artist ?? '').trim()
  if (!q && !a) return []
  return cachedLookup('mb-song-search', `${q}|${a}:${limit}`, THIRTY_DAYS_MS, async () => {
    try {
      let mbQuery: string
      if (a) {
        const parts: string[] = []
        if (q) parts.push(`recording:(${lucene(q)})`)
        parts.push(`artist:(${lucene(a)})`)
        mbQuery = parts.join(' AND ')
      } else {
        mbQuery = lucene(q)
      }
      // Over-fetch, then dedupe by base title + rank so the canonical studio take surfaces
      // first instead of being buried under live/remix/remaster/karaoke duplicates.
      const fetchLimit = Math.min(100, Math.max(limit * 2, 40))
      const data = await mbFetch(`/recording?query=${encodeURIComponent(mbQuery)}&limit=${fetchLimit}`)
      return rankRecordings((data.recordings ?? []), q.toLowerCase(), !!a, limit)
    } catch (err) {
      logger.debug(`[catalog] searchSongs failed: ${String(err)}`)
      return []
    }
  })
}

// ── Entity detail / browse ─────────────────────────────────────────────────────────

export async function getArtist(mbid: string): Promise<CatalogArtistDetail | null> {
  if (!mbid) return null
  return cachedLookup('mb-artist', mbid, THIRTY_DAYS_MS, async () => {
    try {
      const a = await mbFetch(`/artist/${mbid}?inc=url-rels+tags`)
      const rels: any[] = a.relations ?? []
      const findRel = (type: string) => rels.find(r => r.type === type)?.url?.resource ?? null
      const tags = (a.tags ?? [])
        .filter((t: any) => (t.count ?? 0) > 0)
        .sort((x: any, y: any) => (y.count ?? 0) - (x.count ?? 0))
        .slice(0, 8)
        .map((t: any) => t.name as string)
      return {
        mbid: a.id,
        name: a.name,
        disambiguation: a.disambiguation || null,
        type: a.type || null,
        country: a.country || null,
        wikipediaUrl: findRel('wikipedia'),
        wikidataId: (findRel('wikidata') as string | null)?.split('/').pop() ?? null,
        officialUrl: findRel('official homepage'),
        tags,
      }
    } catch (err) {
      logger.debug(`[catalog] getArtist failed: ${String(err)}`)
      return null
    }
  })
}

/** An artist's discography (albums + singles + EPs), newest first. */
export async function getArtistAlbums(mbid: string, limit = 100): Promise<CatalogAlbum[]> {
  if (!mbid) return []
  return cachedLookup('mb-artist-albums', `${mbid}:${limit}`, THIRTY_DAYS_MS, async () => {
    try {
      const data = await mbFetch(`/release-group?artist=${mbid}&type=album|ep|single&limit=${limit}&inc=artist-credits`)
      const albums = (data['release-groups'] ?? []).map(mapReleaseGroup)
      return albums.sort((a: CatalogAlbum, b: CatalogAlbum) => (b.year ?? 0) - (a.year ?? 0))
    } catch (err) {
      logger.debug(`[catalog] getArtistAlbums failed: ${String(err)}`)
      return []
    }
  })
}

/** An album's tracklist, taken from a representative release of the release-group. */
export async function getAlbum(releaseGroupMbid: string): Promise<{ album: CatalogAlbum | null; songs: CatalogSong[] }> {
  if (!releaseGroupMbid) return { album: null, songs: [] }
  return cachedLookup('mb-album', releaseGroupMbid, THIRTY_DAYS_MS, async () => {
    try {
      const rg = await mbFetch(`/release-group/${releaseGroupMbid}?inc=artist-credits+releases`)
      const album = mapReleaseGroup(rg)
      // Pick the first official release of the group and pull its recordings.
      const releases: any[] = rg.releases ?? []
      const chosen = releases.find(r => r.status === 'Official') ?? releases[0]
      if (!chosen) return { album, songs: [] }
      const rel = await mbFetch(`/release/${chosen.id}?inc=recordings+artist-credits`)
      const songs: CatalogSong[] = []
      for (const medium of rel.media ?? []) {
        for (const tr of medium.tracks ?? []) {
          const rec = tr.recording ?? {}
          songs.push({
            mbid: rec.id ?? tr.id,
            title: tr.title ?? rec.title ?? '',
            durationSec: (tr.length ?? rec.length) ? Math.round((tr.length ?? rec.length) / 1000) : null,
            artistName: creditName(rec['artist-credit'] ?? rel['artist-credit']),
            artistMbid: (rec['artist-credit'] ?? rel['artist-credit'])?.[0]?.artist?.id ?? null,
            albumTitle: album.title,
            albumMbid: album.mbid,
          })
        }
      }
      return { album, songs }
    } catch (err) {
      logger.debug(`[catalog] getAlbum failed: ${String(err)}`)
      return { album: null, songs: [] }
    }
  })
}

// ── Mappers ────────────────────────────────────────────────────────────────────────

function creditName(credit: any[] | undefined): string {
  if (!credit?.length) return 'Unknown Artist'
  return credit.map(c => (c.name ?? c.artist?.name ?? '') + (c.joinphrase ?? '')).join('').trim() || 'Unknown Artist'
}

function mapReleaseGroup(rg: any): CatalogAlbum {
  const credit = rg['artist-credit']
  return {
    mbid: rg.id,
    title: rg.title,
    primaryType: rg['primary-type'] || null,
    secondaryTypes: rg['secondary-types'] ?? [],
    firstReleaseDate: rg['first-release-date'] || null,
    year: yearOf(rg['first-release-date']),
    artistName: creditName(credit),
    artistMbid: credit?.[0]?.artist?.id ?? null,
    coverUrl: albumCoverUrl(rg.id),
  }
}

// ── Smart recording ranking (ported/adapted from the Stadium project) ──────────────
// MusicBrainz returns one recording row per release, so a hit like "Everlong" comes back
// dozens of times (album take, live, remaster, karaoke, compilation, video…). We (1) collapse
// them to one row per song and (2) rank so the canonical studio take wins, rather than
// returning them raw where the wanted result is buried.

// Base-title key for dedup: drop parenthetical/bracketed and dashed variant suffixes
// ("(Live)", "[Remastered 2011]", " - Acoustic Version") so every take of a song collapses
// onto the same key. Also folds punctuation/whitespace/case.
function baseTitleKey(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')                 // (…) […]
    .replace(/\s*-\s*(live|remix|remaster(ed)?|acoustic|demo|edit|mono|stereo|version|mix|single|instrumental|karaoke|reprise|session|rehearsal|radio\b.*|extended\b.*).*$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// Only treat a variant word as a penalty when it appears as a labelled suffix — inside
// ( ) / [ ] or after a dash — so a real title like "Live and Let Die" is NOT penalised.
const VARIANT_LABEL_RE = /[([\-].*?\b(live|remix|remaster(ed)?|karaoke|instrumental|acoustic|demo|commentary|cover|reprise|edit|version|mix|a[- ]?cappella|backing track|rehearsal|session|sped[- ]?up|slowed|8d|nightcore)\b/i

function recordingScore(q: string, rec: any): number {
  const title = (rec.title || '').toLowerCase()
  let s = 0
  if (title === q) s += 100
  else if (title.startsWith(q)) s += 55
  else if (title.includes(q)) s += 40

  const releases: any[] = rec.releases ?? []
  if (releases.length) s += 12                                   // a real release (studio) beats a stray recording
  const rg = releases[0]?.['release-group'] ?? {}
  const primary = String(rg['primary-type'] ?? '').toLowerCase()
  if (primary === 'album') s += 12
  else if (primary === 'single') s += 6
  else if (primary === 'ep') s += 4
  for (const t of (rg['secondary-types'] ?? []).map((x: string) => String(x).toLowerCase())) {
    if (t === 'live' || t === 'remix' || t === 'compilation' || t === 'dj-mix' || t === 'demo' || t === 'interview' || t === 'mixtape/street') s -= 12
  }

  if (VARIANT_LABEL_RE.test(rec.title || '')) s -= 10
  const disc = String(rec.disambiguation ?? '').toLowerCase()
  if (disc.includes('cover') || disc.includes('live') || disc.includes('remix') || disc.includes('karaoke') || disc.includes('instrumental')) s -= 8
  if (rec.video) s -= 10                                         // music videos / live clips
  if (rec['first-release-date']) s += 3
  return s
}

// Dedupe by base title (+ artist when the search wasn't already scoped to one artist),
// keeping the highest-scoring take, then sort by score and take the top `limit`.
function rankRecordings(recs: any[], q: string, artistScoped: boolean, limit: number): CatalogSong[] {
  const groups = new Map<string, { rec: any; score: number }>()
  for (const rec of recs) {
    if (!rec?.title) continue
    const artistKey = artistScoped ? '' : (creditName(rec['artist-credit']) || '').toLowerCase()
    const key = `${baseTitleKey(rec.title)}|${artistKey}`
    const score = recordingScore(q, rec)
    const cur = groups.get(key)
    if (!cur || score > cur.score) groups.set(key, { rec, score })
  }
  return [...groups.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((g) => mapRecording(g.rec))
}

function mapRecording(rec: any): CatalogSong {
  const credit = rec['artist-credit']
  const firstRelease = rec.releases?.[0]
  return {
    mbid: rec.id,
    title: rec.title ?? '',
    durationSec: rec.length ? Math.round(rec.length / 1000) : null,
    artistName: creditName(credit),
    artistMbid: credit?.[0]?.artist?.id ?? null,
    albumTitle: firstRelease?.title ?? null,
    albumMbid: firstRelease?.['release-group']?.id ?? null,
  }
}
