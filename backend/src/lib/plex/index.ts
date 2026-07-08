// Plex integration for the Shows + Movies apps. Optional, Home-Assistant-style: the user
// sets a server URL + token in Admin → Features → Plex; everything here is a graceful no-op
// when unconfigured. We match a TVMaze/JustWatch title to the user's Plex library (by IMDb/
// TVDB GUID first, then title+year) so the app can show "In your Plex library" + a deep link,
// surface a "From your Plex" shelf, and best-effort add to the account Watchlist.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { toolGlobalConfig } from '@/db/schema'

export interface PlexConnection {
  baseUrl: string
  token: string
}

export interface PlexMatch {
  present: boolean
  ratingKey: string | null
  title: string | null
  year: number | null
  type: 'movie' | 'show' | null
  deepLink: string | null
  guids: string[]
}

export interface PlexLibraryItem {
  ratingKey: string
  title: string
  year: number | null
  type: 'movie' | 'show'
  thumbUrl: string | null
  deepLink: string | null
}

// A movie/show normalized out of any local PMS feed (recentlyAdded, onDeck, hubs, sessions).
// `thumb` is the relative Plex path (no token) — proxy it through /api/plex/img. `guids` are
// the external IMDb/TVDB ids when present; the resolver falls back to title+year otherwise.
export interface PlexNormItem {
  type: 'movie' | 'show'
  title: string
  year: number | null
  guids: string[]
  thumb: string | null
  ratingKey: string
  // Optional in-progress hint (onDeck): how far through (0..1) and the episode label.
  progress?: number | null
  episodeLabel?: string | null
}

// The Plex cloud (discover.provider.plex.tv) — account Watchlist + global metadata search.
const DISCOVER = 'https://discover.provider.plex.tv'
const CLIENT_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'X-Plex-Product': 'Media Companion',
  'X-Plex-Version': '1.0',
  'X-Plex-Client-Identifier': 'media-companion-server',
}

const TIMEOUT_MS = 6000

export async function getPlexConnection(): Promise<PlexConnection | null> {
  try {
    const rows = await db.select().from(toolGlobalConfig).where(eq(toolGlobalConfig.toolId, 'plex'))
    let baseUrl = ''
    let token = ''
    for (const r of rows) {
      if (r.key === 'base_url') baseUrl = String(JSON.parse(r.value) ?? '').trim().replace(/\/+$/, '')
      if (r.key === 'token') token = String(JSON.parse(r.value) ?? '').trim()
    }
    if (!baseUrl || !token) return null
    return { baseUrl, token }
  } catch {
    return null
  }
}

export async function isPlexConfigured(): Promise<boolean> {
  return (await getPlexConnection()) !== null
}

// timeoutMs: the 6s default fits quick metadata calls; bulk pagination (music library sync
// pulls 200-track pages) legitimately needs longer — pass ~20s there, not everywhere.
export async function plexGet<T>(conn: PlexConnection, path: string, timeoutMs = TIMEOUT_MS): Promise<T | null> {
  try {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${conn.baseUrl}${path}${sep}X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

interface PlexMeta {
  ratingKey?: string
  title?: string
  year?: number
  type?: string
  thumb?: string
  Guid?: Array<{ id?: string }>
  // Episode/season → parent show fields, used to roll up onDeck/hub episodes to their show.
  grandparentTitle?: string
  grandparentThumb?: string
  grandparentRatingKey?: string
  parentIndex?: number
  parentYear?: number
  index?: number
  viewCount?: number
  viewOffset?: number
  duration?: number
}
interface PlexContainer {
  MediaContainer?: { machineIdentifier?: string; Metadata?: PlexMeta[] }
}

/** Roll any local PMS metadata item up to a normalized movie/show. Episodes → their show. */
function normFromMeta(m: PlexMeta): PlexNormItem | null {
  if (m.type === 'movie') {
    return { type: 'movie', title: m.title ?? '', year: m.year ?? null, guids: guidList(m), thumb: m.thumb ?? null, ratingKey: m.ratingKey ?? '' }
  }
  if (m.type === 'show') {
    return { type: 'show', title: m.title ?? '', year: m.year ?? null, guids: guidList(m), thumb: m.thumb ?? null, ratingKey: m.ratingKey ?? '' }
  }
  if (m.type === 'episode' || m.type === 'season') {
    const label = m.parentIndex != null && m.index != null ? `S${m.parentIndex}E${m.index} · ${m.title ?? ''}`.trim() : (m.title ?? null)
    const progress = m.viewOffset != null && m.duration ? Math.min(1, m.viewOffset / m.duration) : null
    return {
      type: 'show',
      title: m.grandparentTitle ?? m.title ?? '',
      year: m.parentYear ?? m.year ?? null,
      guids: [],
      thumb: m.grandparentThumb ?? m.thumb ?? null,
      ratingKey: m.grandparentRatingKey ?? m.ratingKey ?? '',
      progress,
      episodeLabel: label,
    }
  }
  return null
}

/** GET that only cares whether the call succeeded (Plex action endpoints return no JSON). */
async function plexPing(conn: PlexConnection, path: string): Promise<boolean> {
  try {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${conn.baseUrl}${path}${sep}X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

/** GET against a Plex cloud host (discover/metadata providers) with account headers. */
async function plexCloudGet<T>(conn: PlexConnection, base: string, path: string): Promise<T | null> {
  try {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${base}${path}${sep}X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      headers: CLIENT_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** PUT a discover.provider.plex.tv action (add/remove watchlist). Returns success. */
async function plexCloudAction(conn: PlexConnection, path: string): Promise<boolean> {
  try {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${DISCOVER}${path}${sep}X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      method: 'PUT',
      headers: CLIENT_HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return res.ok
  } catch {
    return false
  }
}

let _machineId: string | null | undefined
export async function machineId(conn: PlexConnection): Promise<string | null> {
  if (_machineId !== undefined) return _machineId
  const data = await plexGet<PlexContainer>(conn, '/identity')
  _machineId = data?.MediaContainer?.machineIdentifier ?? null
  return _machineId
}

/** Drop the memoised machine id. The module-level memo never expires on its own, so a
 *  server swap would keep answering with the OLD id — the music sync calls this so
 *  `plex:<machineId>:<ratingKey>` refs are verified against the current server. */
export function resetMachineIdCache(): void {
  _machineId = undefined
}

function deepLink(mid: string | null, ratingKey: string): string | null {
  if (!mid) return null
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`)
  // app.plex.tv remembers the user's Plex login across sessions (the local server's /web app is
  // signed out per-browser), so "Play on Plex" works after a one-time sign-in at plex.tv.
  return `https://app.plex.tv/desktop/#!/server/${mid}/details?key=${key}`
}

export async function plexStatus(conn: PlexConnection): Promise<{ ok: boolean; serverName: string | null }> {
  const data = await plexGet<PlexContainer & { MediaContainer?: { friendlyName?: string } }>(conn, '/')
  const mc = data?.MediaContainer as { friendlyName?: string } | undefined
  return { ok: !!data, serverName: mc?.friendlyName ?? null }
}

function guidList(meta: PlexMeta): string[] {
  return (meta.Guid ?? []).map((g) => String(g.id ?? '')).filter(Boolean)
}

export async function findInPlex(
  conn: PlexConnection,
  q: { type: 'movie' | 'show'; title: string; year?: number | null; imdb?: string | null; tvdb?: number | null },
): Promise<PlexMatch> {
  const empty: PlexMatch = { present: false, ratingKey: null, title: null, year: null, type: null, deepLink: null, guids: [] }
  const plexType = q.type === 'movie' ? 1 : 2
  const data = await plexGet<PlexContainer>(conn, `/library/all?type=${plexType}&title=${encodeURIComponent(q.title)}`)
  const metas = data?.MediaContainer?.Metadata ?? []
  if (!metas.length) return empty

  const wantImdb = q.imdb ? `imdb://${q.imdb}` : null
  const wantTvdb = q.tvdb ? `tvdb://${q.tvdb}` : null
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const wantTitle = norm(q.title)

  // Prefer a GUID match; fall back to title (+ year within 1).
  const byGuid = metas.find((m) => {
    const guids = guidList(m)
    return (wantImdb && guids.some((g) => g.startsWith(wantImdb))) || (wantTvdb && guids.some((g) => g.startsWith(wantTvdb)))
  })
  const byTitle = metas.find((m) => norm(String(m.title ?? '')) === wantTitle && (!q.year || !m.year || Math.abs(m.year - q.year) <= 1))
  const hit = byGuid ?? byTitle
  if (!hit?.ratingKey) return empty

  const mid = await machineId(conn)
  return {
    present: true,
    ratingKey: hit.ratingKey,
    title: hit.title ?? null,
    year: hit.year ?? null,
    type: q.type,
    deepLink: deepLink(mid, hit.ratingKey),
    guids: guidList(hit),
  }
}

function dedupeNorm(items: PlexNormItem[], limit: number): PlexNormItem[] {
  const out: PlexNormItem[] = []
  const seen = new Set<string>()
  for (const n of items) {
    const key = n.ratingKey || `${n.type}:${n.title}:${n.year ?? ''}`
    if (!n.title || seen.has(key)) continue
    seen.add(key)
    out.push(n)
    if (out.length >= limit) break
  }
  return out
}

export async function recentlyAdded(conn: PlexConnection, limit = 20): Promise<PlexNormItem[]> {
  const data = await plexGet<PlexContainer>(conn, `/library/recentlyAdded?X-Plex-Container-Size=${limit}&X-Plex-Container-Start=0`)
  const metas = data?.MediaContainer?.Metadata ?? []
  return dedupeNorm(metas.map(normFromMeta).filter((n): n is PlexNormItem => !!n), limit)
}

/** In-progress + next-up items ("On Deck") from the server, rolled up to movies/shows. */
export async function onDeck(conn: PlexConnection, limit = 20): Promise<PlexNormItem[]> {
  const data = await plexGet<PlexContainer>(conn, '/library/onDeck')
  const metas = data?.MediaContainer?.Metadata ?? []
  return dedupeNorm(metas.map(normFromMeta).filter((n): n is PlexNormItem => !!n), limit)
}

/** Plex's own recommendation hubs (e.g. "Recently Released", "Because you watched…"). */
export async function hubs(conn: PlexConnection, limit = 20): Promise<PlexNormItem[]> {
  const data = await plexGet<{ MediaContainer?: { Hub?: Array<{ Metadata?: PlexMeta[] }> } }>(conn, '/hubs?count=20')
  const all: PlexNormItem[] = []
  for (const h of data?.MediaContainer?.Hub ?? []) {
    for (const m of h.Metadata ?? []) {
      const n = normFromMeta(m)
      if (n) all.push(n)
    }
  }
  return dedupeNorm(all, limit)
}

export interface PlexSection {
  key: string
  type: 'movie' | 'show' | 'artist' | 'other'
  title: string
}

/** Enumerate the server's library sections (Movies, TV Shows, Music, …). Music libraries
 *  report type 'artist' — Plex's name for a music section's top-level container. */
export async function sections(conn: PlexConnection): Promise<PlexSection[]> {
  const data = await plexGet<{ MediaContainer?: { Directory?: Array<{ key?: string; type?: string; title?: string }> } }>(conn, '/library/sections')
  return (data?.MediaContainer?.Directory ?? [])
    .map((d) => ({
      key: String(d.key ?? ''),
      type: (d.type === 'movie' ? 'movie' : d.type === 'show' ? 'show' : d.type === 'artist' ? 'artist' : 'other') as PlexSection['type'],
      title: String(d.title ?? ''),
    }))
    .filter((d) => d.key)
}

/** Browse the contents of one library section. */
export async function sectionAll(conn: PlexConnection, sectionKey: string, limit = 40): Promise<PlexNormItem[]> {
  const data = await plexGet<PlexContainer>(conn, `/library/sections/${encodeURIComponent(sectionKey)}/all?X-Plex-Container-Size=${limit}&X-Plex-Container-Start=0`)
  const metas = data?.MediaContainer?.Metadata ?? []
  return dedupeNorm(metas.map(normFromMeta).filter((n): n is PlexNormItem => !!n), limit)
}

export interface PlexSession {
  title: string
  showTitle: string | null
  type: 'movie' | 'episode' | 'other'
  user: string | null
  player: string | null
  thumb: string | null
  state: string | null
  progress: number | null
}

/** What's currently streaming on the server right now. */
export async function sessions(conn: PlexConnection): Promise<PlexSession[]> {
  const data = await plexGet<{
    MediaContainer?: {
      Metadata?: Array<
        PlexMeta & { User?: { title?: string }; Player?: { title?: string; state?: string }; viewOffset?: number; duration?: number }
      >
    }
  }>(conn, '/status/sessions')
  return (data?.MediaContainer?.Metadata ?? []).map((m) => ({
    title: m.type === 'episode' ? (m.title ?? '') : (m.title ?? ''),
    showTitle: m.type === 'episode' ? (m.grandparentTitle ?? null) : null,
    type: m.type === 'movie' ? 'movie' : m.type === 'episode' ? 'episode' : 'other',
    user: m.User?.title ?? null,
    player: m.Player?.title ?? null,
    thumb: m.grandparentThumb ?? m.thumb ?? null,
    state: m.Player?.state ?? null,
    progress: m.viewOffset != null && m.duration ? Math.min(1, m.viewOffset / m.duration) : null,
  }))
}

export interface PlexLeaf {
  ratingKey: string
  season: number
  number: number | null
  viewCount: number
}

/** Every episode of a show on the server, with watched state — to map TVMaze ⇄ Plex episodes. */
export async function allLeaves(conn: PlexConnection, showRatingKey: string): Promise<PlexLeaf[]> {
  const data = await plexGet<PlexContainer>(conn, `/library/metadata/${encodeURIComponent(showRatingKey)}/allLeaves`)
  return (data?.MediaContainer?.Metadata ?? [])
    .map((m) => ({
      ratingKey: String(m.ratingKey ?? ''),
      season: Number(m.parentIndex ?? 0),
      number: m.index != null ? Number(m.index) : null,
      viewCount: Number(m.viewCount ?? 0),
    }))
    .filter((l) => l.ratingKey)
}

export interface PlexSectionEpisode {
  ratingKey: string
  viewCount: number
  /** The media file's path AS PLEX SEES IT (Media[0].Part[0].file) — null when the item
   *  hasn't been fully analyzed yet (fresh scan race). */
  file: string | null
}

/** Every episode in a SECTION with watched state + backing file path — one call per
 *  section, for the remove-watched sweep over exported video libraries. `type=4` is
 *  Plex's episode type filter; Media/Part are included by default in section listings. */
export async function sectionEpisodes(conn: PlexConnection, sectionKey: string): Promise<PlexSectionEpisode[]> {
  interface EpisodeMeta extends PlexMeta { Media?: Array<{ Part?: Array<{ file?: string }> }> }
  const data = await plexGet<{ MediaContainer?: { Metadata?: EpisodeMeta[] } }>(
    conn, `/library/sections/${encodeURIComponent(sectionKey)}/all?type=4`)
  return (data?.MediaContainer?.Metadata ?? [])
    .map((m) => ({
      ratingKey: String(m.ratingKey ?? ''),
      viewCount: Number(m.viewCount ?? 0),
      file: m.Media?.[0]?.Part?.[0]?.file ?? null,
    }))
    .filter((e) => e.ratingKey)
}

/** Mark an item watched on the server (scrobble). */
export async function scrobble(conn: PlexConnection, ratingKey: string): Promise<boolean> {
  if (!ratingKey) return false
  return plexPing(conn, `/:/scrobble?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(ratingKey)}`)
}

/** Mark an item unwatched on the server. */
export async function unscrobble(conn: PlexConnection, ratingKey: string): Promise<boolean> {
  if (!ratingKey) return false
  return plexPing(conn, `/:/unscrobble?identifier=com.plexapp.plugins.library&key=${encodeURIComponent(ratingKey)}`)
}

/** Fetch a Plex image (thumb/art) server-side so the account token never reaches the browser. */
export async function fetchPlexImage(conn: PlexConnection, path: string): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  try {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${conn.baseUrl}${path}${sep}X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    return { data: await res.arrayBuffer(), contentType: res.headers.get('content-type') ?? 'image/jpeg' }
  } catch {
    return null
  }
}

// ── account Watchlist (discover.provider.plex.tv cloud API) ──────────────────────

export interface DiscoverHit {
  ratingKey: string
  guid: string | null
  type: 'movie' | 'show'
  title: string
  year: number | null
  guids: string[]
}

function collectDiscoverMetas(data: unknown): PlexMeta[] {
  const mc = (data as { MediaContainer?: Record<string, unknown> })?.MediaContainer
  if (!mc) return []
  // Discover search nests as MediaContainer.SearchResults[].SearchResult[].Metadata; some
  // endpoints return MediaContainer.Metadata directly. Handle both.
  if (Array.isArray((mc as { Metadata?: PlexMeta[] }).Metadata)) return (mc as { Metadata: PlexMeta[] }).Metadata
  const out: PlexMeta[] = []
  const results = (mc as { SearchResults?: Array<{ SearchResult?: Array<{ Metadata?: PlexMeta }> }> }).SearchResults ?? []
  for (const group of results) {
    for (const r of group.SearchResult ?? []) {
      if (r.Metadata) out.push(r.Metadata)
    }
  }
  const flat = (mc as { SearchResult?: Array<{ Metadata?: PlexMeta }> }).SearchResult ?? []
  for (const r of flat) if (r.Metadata) out.push(r.Metadata)
  return out
}

/** Resolve a title to a global Discover ratingKey (needed to add to the account Watchlist). */
export async function searchDiscover(
  conn: PlexConnection,
  q: { type: 'movie' | 'show'; title: string; year?: number | null },
): Promise<DiscoverHit | null> {
  const searchType = q.type === 'movie' ? 'movies' : 'tv'
  const data = await plexCloudGet<unknown>(
    conn,
    DISCOVER,
    `/library/search?query=${encodeURIComponent(q.title)}&searchTypes=${searchType}&searchProviders=discover&limit=10&includeMetadata=1`,
  )
  const metas = collectDiscoverMetas(data).filter((m) => (q.type === 'movie' ? m.type === 'movie' : m.type === 'show'))
  if (!metas.length) return null
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const want = norm(q.title)
  const pick =
    metas.find((m) => norm(String(m.title ?? '')) === want && (!q.year || !m.year || Math.abs((m.year ?? 0) - q.year) <= 1)) ??
    metas.find((m) => norm(String(m.title ?? '')) === want) ??
    metas[0]
  if (!pick?.ratingKey && !pick?.Guid?.length) return null
  const guid = (pick as { guid?: string }).guid ?? null
  const ratingKey = pick.ratingKey ?? (guid ? guid.replace(/^plex:\/\//, '') : '')
  if (!ratingKey) return null
  return { ratingKey, guid, type: q.type, title: pick.title ?? q.title, year: pick.year ?? q.year ?? null, guids: guidList(pick) }
}

/** Read the account Watchlist (cloud). Returns normalized movie/show entries. */
export async function getAccountWatchlist(conn: PlexConnection): Promise<DiscoverHit[]> {
  const data = await plexCloudGet<PlexContainer>(
    conn,
    DISCOVER,
    '/library/sections/watchlist/all?X-Plex-Container-Size=300&includeGuids=1',
  )
  const metas = data?.MediaContainer?.Metadata ?? []
  return metas
    .map((m): DiscoverHit | null => {
      const type = m.type === 'movie' ? 'movie' : m.type === 'show' ? 'show' : null
      if (!type || !m.ratingKey) return null
      return { ratingKey: m.ratingKey, guid: (m as { guid?: string }).guid ?? null, type, title: m.title ?? '', year: m.year ?? null, guids: guidList(m) }
    })
    .filter((d): d is DiscoverHit => !!d)
}

// Best-effort add to the account Watchlist (discover.provider.plex.tv). `ratingKey` is the
// global Discover ratingKey (from searchDiscover/getAccountWatchlist), NOT a local server key.
export async function addToPlexWatchlist(conn: PlexConnection, ratingKey: string): Promise<boolean> {
  const rk = ratingKey.replace(/^plex:\/\//, '')
  if (!rk) return false
  return plexCloudAction(conn, `/actions/addToWatchlist?ratingKey=${encodeURIComponent(rk)}`)
}

/** Remove an item from the account Watchlist. */
export async function removeFromPlexWatchlist(conn: PlexConnection, ratingKey: string): Promise<boolean> {
  const rk = ratingKey.replace(/^plex:\/\//, '')
  if (!rk) return false
  return plexCloudAction(conn, `/actions/removeFromWatchlist?ratingKey=${encodeURIComponent(rk)}`)
}

// ── in-app playback (direct stream of the original file) ─────────────────────────

export interface PlexPlayback {
  ratingKey: string
  title: string
  partKey: string | null
  container: string | null
  videoCodec: string | null
  audioCodec: string | null
  durationMs: number | null
  // True when the file is one browsers can play natively (h264 + aac/mp3 in an mp4 container),
  // so we can direct-stream the bytes. Otherwise the UI falls back to the Plex deep link
  // (server-side HLS transcode is intentionally out of scope here).
  directPlay: boolean
}

const BROWSER_CONTAINERS = new Set(['mp4', 'm4v', 'mov'])

/** Resolve the playable part + codecs for an item, and whether the browser can direct-play it. */
export async function getPlayback(conn: PlexConnection, ratingKey: string): Promise<PlexPlayback | null> {
  const data = await plexGet<{
    MediaContainer?: {
      Metadata?: Array<
        PlexMeta & {
          duration?: number
          Media?: Array<{ container?: string; videoCodec?: string; audioCodec?: string; Part?: Array<{ key?: string; container?: string }> }>
        }
      >
    }
  }>(conn, `/library/metadata/${encodeURIComponent(ratingKey)}`)
  const m = data?.MediaContainer?.Metadata?.[0]
  if (!m) return null
  const media = m.Media?.[0]
  const part = media?.Part?.[0]
  const container = (media?.container ?? part?.container ?? '').toLowerCase() || null
  const videoCodec = media?.videoCodec?.toLowerCase() ?? null
  const audioCodec = media?.audioCodec?.toLowerCase() ?? null
  const directPlay =
    !!part?.key && !!container && BROWSER_CONTAINERS.has(container) && videoCodec === 'h264' && (audioCodec === 'aac' || audioCodec === 'mp3')
  return { ratingKey, title: m.title ?? '', partKey: part?.key ?? null, container, videoCodec, audioCodec, durationMs: m.duration ?? null, directPlay }
}

/** Open a range-aware byte stream of a part file. Returns the raw upstream Response to pipe. */
export async function streamPart(conn: PlexConnection, partKey: string, range?: string): Promise<Response | null> {
  try {
    const sep = partKey.includes('?') ? '&' : '?'
    const headers: Record<string, string> = {}
    if (range) headers['Range'] = range
    // No timeout: this is a long-lived media stream, not a metadata call.
    return await fetch(`${conn.baseUrl}${partKey}${sep}X-Plex-Token=${encodeURIComponent(conn.token)}`, { headers })
  } catch {
    return null
  }
}
