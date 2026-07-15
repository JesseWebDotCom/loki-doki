// Optional LAN integrations for the Shows/Movies apps: Sonarr + Radarr (library calendars)
// and Overseerr (request pipeline). Admin-configured (URL + API key per service) on the
// shared toolGlobalConfig table under toolId 'media_integrations' — the same storage the
// Plex integration uses. Everything degrades to empty/no-op when unconfigured.

import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { toolGlobalConfig } from '@/db/schema'
import { cachedLookup } from '@/lib/lookupCache'

const TOOL_ID = 'media_integrations'
export const INTEGRATION_KEYS = [
  'sonarr_url', 'sonarr_key', 'radarr_url', 'radarr_key', 'overseerr_url', 'overseerr_key',
  'sabnzbd_url', 'sabnzbd_key', 'request_pipeline',
  'radarr_quality_profile_id', 'radarr_root_folder', 'sonarr_quality_profile_id', 'sonarr_root_folder',
] as const
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number]

/** Keys that hold secrets: masked in GET /config, blank writes never clobber them. */
export const INTEGRATION_SECRET_KEYS: readonly IntegrationKey[] = ['sonarr_key', 'radarr_key', 'overseerr_key', 'sabnzbd_key']

export type RequestPipeline = 'overseerr' | 'direct'

/** Which pipeline the Request button files through. Defaults to Overseerr (the original behavior). */
export async function getRequestPipeline(): Promise<RequestPipeline> {
  const cfg = await getIntegrationsConfig()
  return cfg.request_pipeline === 'direct' ? 'direct' : 'overseerr'
}

export async function getIntegrationsConfig(): Promise<Record<IntegrationKey, string>> {
  const rows = await db.select().from(toolGlobalConfig).where(eq(toolGlobalConfig.toolId, TOOL_ID))
  const out = Object.fromEntries(INTEGRATION_KEYS.map((k) => [k, ''])) as Record<IntegrationKey, string>
  for (const row of rows) {
    if ((INTEGRATION_KEYS as readonly string[]).includes(row.key)) {
      try { out[row.key as IntegrationKey] = String(JSON.parse(row.value) ?? '') } catch { /* ignore */ }
    }
  }
  return out
}

export async function setIntegrationsConfig(patch: Partial<Record<IntegrationKey, string>>): Promise<void> {
  for (const key of INTEGRATION_KEYS) {
    if (!(key in patch)) continue
    const value = String(patch[key] ?? '').trim()
    const where = and(eq(toolGlobalConfig.toolId, TOOL_ID), eq(toolGlobalConfig.key, key))
    const [existing] = await db.select({ id: toolGlobalConfig.id }).from(toolGlobalConfig).where(where).limit(1)
    if (existing) {
      await db.update(toolGlobalConfig).set({ value: JSON.stringify(value), updatedAt: new Date() }).where(where)
    } else {
      await db.insert(toolGlobalConfig).values({
        id: crypto.randomUUID(), toolId: TOOL_ID, key, value: JSON.stringify(value), updatedAt: new Date(),
      })
    }
  }
}

function baseUrl(u: string): string {
  return u.trim().replace(/\/+$/, '')
}

async function arrGet<T>(url: string, key: string, path: string): Promise<T | null> {
  try {
    const res = await fetch(`${baseUrl(url)}${path}`, {
      headers: { 'X-Api-Key': key, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function arrPost<T>(url: string, key: string, path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${baseUrl(url)}${path}`, {
      method: 'POST',
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

// ── Radarr/Sonarr direct pipeline: lookups, profiles, add, queue ─────────────────────

export interface ArrLookupResult {
  title: string
  year: number | null
  tmdbId: number | null   // Radarr
  tvdbId: number | null   // Sonarr
  posterUrl: string | null
  /** Non-null when the title is already in the arr library. */
  libraryId: number | null
  hasFile: boolean
}

interface RadarrMovie {
  id?: number; title?: string; year?: number; tmdbId?: number; hasFile?: boolean
  images?: Array<{ coverType?: string; remoteUrl?: string; url?: string }>
}
interface SonarrSeries {
  id?: number; title?: string; year?: number; tvdbId?: number
  statistics?: { percentOfEpisodes?: number; episodeFileCount?: number }
  images?: Array<{ coverType?: string; remoteUrl?: string; url?: string }>
}

function arrPoster(images?: Array<{ coverType?: string; remoteUrl?: string; url?: string }>): string | null {
  const img = (images ?? []).find((i) => i.coverType === 'poster')
  return img?.remoteUrl ?? img?.url ?? null
}

/** Resolve a movie against Radarr's own lookup (prefers imdb id, falls back to title+year). */
export async function radarrLookup(q: { imdb?: string | null; title: string; year?: number | null }): Promise<ArrLookupResult | null> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.radarr_url || !cfg.radarr_key) return null
  const term = q.imdb ? `imdb:${q.imdb}` : q.title
  const results = await arrGet<RadarrMovie[]>(cfg.radarr_url, cfg.radarr_key, `/api/v3/movie/lookup?term=${encodeURIComponent(term)}`)
  if (!results?.length) return null
  const match = q.imdb ? results[0] : (
    results.find((r) => {
      if ((r.title ?? '').toLowerCase() !== q.title.toLowerCase()) return false
      return !q.year || !r.year || Math.abs(r.year - q.year) <= 1
    }) ?? results[0]
  )
  if (!match?.tmdbId) return null
  return {
    title: match.title ?? q.title, year: match.year ?? null, tmdbId: match.tmdbId, tvdbId: null,
    posterUrl: arrPoster(match.images), libraryId: match.id ?? null, hasFile: match.hasFile === true,
  }
}

/** Resolve a series against Sonarr's lookup by TVDB id (or title as fallback). */
export async function sonarrLookup(q: { tvdb?: number | null; title: string; year?: number | null }): Promise<ArrLookupResult | null> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.sonarr_url || !cfg.sonarr_key) return null
  const term = q.tvdb ? `tvdb:${q.tvdb}` : q.title
  const results = await arrGet<SonarrSeries[]>(cfg.sonarr_url, cfg.sonarr_key, `/api/v3/series/lookup?term=${encodeURIComponent(term)}`)
  if (!results?.length) return null
  const match = q.tvdb ? results[0] : (
    results.find((r) => {
      if ((r.title ?? '').toLowerCase() !== q.title.toLowerCase()) return false
      return !q.year || !r.year || Math.abs(r.year - q.year) <= 1
    }) ?? results[0]
  )
  if (!match?.tvdbId) return null
  const pct = match.statistics?.percentOfEpisodes ?? 0
  return {
    title: match.title ?? q.title, year: match.year ?? null, tmdbId: null, tvdbId: match.tvdbId,
    posterUrl: arrPoster(match.images), libraryId: match.id ?? null,
    hasFile: match.id != null && pct >= 100,
  }
}

export interface ArrProfile { id: number; name: string }
export interface ArrRootFolder { id: number; path: string }

export async function radarrProfiles(): Promise<ArrProfile[]> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.radarr_url || !cfg.radarr_key) return []
  return (await arrGet<ArrProfile[]>(cfg.radarr_url, cfg.radarr_key, '/api/v3/qualityprofile')) ?? []
}
export async function radarrRootFolders(): Promise<ArrRootFolder[]> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.radarr_url || !cfg.radarr_key) return []
  return (await arrGet<ArrRootFolder[]>(cfg.radarr_url, cfg.radarr_key, '/api/v3/rootfolder')) ?? []
}
export async function sonarrProfiles(): Promise<ArrProfile[]> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.sonarr_url || !cfg.sonarr_key) return []
  return (await arrGet<ArrProfile[]>(cfg.sonarr_url, cfg.sonarr_key, '/api/v3/qualityprofile')) ?? []
}
export async function sonarrRootFolders(): Promise<ArrRootFolder[]> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.sonarr_url || !cfg.sonarr_key) return []
  return (await arrGet<ArrRootFolder[]>(cfg.sonarr_url, cfg.sonarr_key, '/api/v3/rootfolder')) ?? []
}

/** Add a movie to Radarr and kick off a search. Returns the Radarr movie id. */
export async function radarrAddMovie(tmdbId: number): Promise<number | null> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.radarr_url || !cfg.radarr_key) return null
  const [movie] = (await arrGet<RadarrMovie[]>(cfg.radarr_url, cfg.radarr_key, `/api/v3/movie/lookup?term=tmdb:${tmdbId}`)) ?? []
  if (!movie?.tmdbId) return null
  const qualityProfileId = Number(cfg.radarr_quality_profile_id) || (await radarrProfiles())[0]?.id
  const rootFolderPath = cfg.radarr_root_folder || (await radarrRootFolders())[0]?.path
  if (!qualityProfileId || !rootFolderPath) return null
  const added = await arrPost<{ id?: number }>(cfg.radarr_url, cfg.radarr_key, '/api/v3/movie', {
    ...movie, qualityProfileId, rootFolderPath, monitored: true,
    addOptions: { searchForMovie: true },
  })
  return added?.id ?? null
}

/** Add a series to Sonarr (all seasons monitored) and kick off a search. Returns the Sonarr series id. */
export async function sonarrAddSeries(tvdbId: number): Promise<number | null> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.sonarr_url || !cfg.sonarr_key) return null
  const [series] = (await arrGet<SonarrSeries[]>(cfg.sonarr_url, cfg.sonarr_key, `/api/v3/series/lookup?term=tvdb:${tvdbId}`)) ?? []
  if (!series?.tvdbId) return null
  const qualityProfileId = Number(cfg.sonarr_quality_profile_id) || (await sonarrProfiles())[0]?.id
  const rootFolderPath = cfg.sonarr_root_folder || (await sonarrRootFolders())[0]?.path
  if (!qualityProfileId || !rootFolderPath) return null
  const added = await arrPost<{ id?: number }>(cfg.sonarr_url, cfg.sonarr_key, '/api/v3/series', {
    ...series, qualityProfileId, rootFolderPath, monitored: true,
    addOptions: { searchForMissingEpisodes: true },
  })
  return added?.id ?? null
}

export interface ArrQueueItem {
  arr: 'radarr' | 'sonarr'
  /** Radarr movie id / Sonarr series id the queue item belongs to. */
  libraryId: number | null
  title: string
  status: string
  /** 0..100 */
  progress: number
  timeLeft: string | null
  size: number
  sizeLeft: number
}

interface ArrQueuePage<T> { records?: T[] }
interface RadarrQueueRecord { movieId?: number; title?: string; status?: string; size?: number; sizeleft?: number; timeleft?: string; movie?: { title?: string } }
interface SonarrQueueRecord { seriesId?: number; title?: string; status?: string; size?: number; sizeleft?: number; timeleft?: string; series?: { title?: string } }

function queueProgress(size?: number, sizeleft?: number): number {
  if (!size || size <= 0) return 0
  const done = size - (sizeleft ?? size)
  return Math.max(0, Math.min(100, Math.round((done / size) * 100)))
}

export async function radarrQueue(): Promise<ArrQueueItem[]> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.radarr_url || !cfg.radarr_key) return []
  const page = await arrGet<ArrQueuePage<RadarrQueueRecord>>(cfg.radarr_url, cfg.radarr_key, '/api/v3/queue?pageSize=100&includeMovie=true')
  return (page?.records ?? []).map((r) => ({
    arr: 'radarr' as const, libraryId: r.movieId ?? null,
    title: r.movie?.title ?? r.title ?? 'Unknown', status: r.status ?? 'unknown',
    progress: queueProgress(r.size, r.sizeleft), timeLeft: r.timeleft ?? null,
    size: r.size ?? 0, sizeLeft: r.sizeleft ?? 0,
  }))
}

export async function sonarrQueue(): Promise<ArrQueueItem[]> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.sonarr_url || !cfg.sonarr_key) return []
  const page = await arrGet<ArrQueuePage<SonarrQueueRecord>>(cfg.sonarr_url, cfg.sonarr_key, '/api/v3/queue?pageSize=100&includeSeries=true')
  return (page?.records ?? []).map((r) => ({
    arr: 'sonarr' as const, libraryId: r.seriesId ?? null,
    title: r.series?.title ?? r.title ?? 'Unknown', status: r.status ?? 'unknown',
    progress: queueProgress(r.size, r.sizeleft), timeLeft: r.timeleft ?? null,
    size: r.size ?? 0, sizeLeft: r.sizeleft ?? 0,
  }))
}

/** Fetch a Radarr movie by library id (for hasFile checks). */
export async function radarrMovieById(id: number): Promise<{ hasFile: boolean } | null> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.radarr_url || !cfg.radarr_key) return null
  const m = await arrGet<RadarrMovie>(cfg.radarr_url, cfg.radarr_key, `/api/v3/movie/${id}`)
  return m ? { hasFile: m.hasFile === true } : null
}

/** Fetch a Sonarr series by library id; "hasFile" = at least one episode file downloaded. */
export async function sonarrSeriesById(id: number): Promise<{ hasFile: boolean } | null> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.sonarr_url || !cfg.sonarr_key) return null
  const s = await arrGet<SonarrSeries>(cfg.sonarr_url, cfg.sonarr_key, `/api/v3/series/${id}`)
  return s ? { hasFile: (s.statistics?.episodeFileCount ?? 0) > 0 } : null
}

/** Cheap connectivity probe for the admin Test button. */
export async function arrSystemStatus(kind: 'radarr' | 'sonarr'): Promise<{ ok: boolean; version?: string }> {
  const cfg = await getIntegrationsConfig()
  const url = kind === 'radarr' ? cfg.radarr_url : cfg.sonarr_url
  const key = kind === 'radarr' ? cfg.radarr_key : cfg.sonarr_key
  if (!url || !key) return { ok: false }
  const status = await arrGet<{ version?: string }>(url, key, '/api/v3/system/status')
  return status ? { ok: true, version: status.version } : { ok: false }
}

// ── Library calendar (Sonarr episodes + Radarr releases, next N days) ────────────────

export interface LibraryCalendarEntry {
  kind: 'episode' | 'movie'
  title: string        // series or movie title
  detail: string | null // "S2E4 Episode Name" / "Digital release"
  date: string         // YYYY-MM-DD
  hasFile: boolean
}

interface SonarrCalItem {
  title?: string; seasonNumber?: number; episodeNumber?: number; airDate?: string; hasFile?: boolean
  series?: { title?: string }
}
interface RadarrCalItem {
  title?: string; digitalRelease?: string; physicalRelease?: string; inCinemas?: string; hasFile?: boolean
}

/** Merged "coming to your library" calendar. Empty when neither arr is configured. */
export async function getLibraryCalendar(days = 14): Promise<LibraryCalendarEntry[]> {
  const cfg = await getIntegrationsConfig()
  return cachedLookup('arr-calendar', `v1:${days}`, 15 * 60 * 1000, async () => {
    const start = new Date().toISOString().slice(0, 10)
    const end = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
    const out: LibraryCalendarEntry[] = []

    if (cfg.sonarr_url && cfg.sonarr_key) {
      const eps = await arrGet<SonarrCalItem[]>(cfg.sonarr_url, cfg.sonarr_key, `/api/v3/calendar?start=${start}&end=${end}&includeSeries=true`)
      for (const e of eps ?? []) {
        if (!e.airDate) continue
        out.push({
          kind: 'episode',
          title: e.series?.title ?? 'Unknown series',
          detail: [
            e.seasonNumber != null && e.episodeNumber != null ? `S${e.seasonNumber}E${e.episodeNumber}` : null,
            e.title ?? null,
          ].filter(Boolean).join(' '),
          date: e.airDate,
          hasFile: e.hasFile === true,
        })
      }
    }

    if (cfg.radarr_url && cfg.radarr_key) {
      const movies = await arrGet<RadarrCalItem[]>(cfg.radarr_url, cfg.radarr_key, `/api/v3/calendar?start=${start}&end=${end}`)
      for (const m of movies ?? []) {
        const date = (m.digitalRelease ?? m.physicalRelease ?? m.inCinemas ?? '').slice(0, 10)
        if (!m.title || !date || date < start || date > end) continue
        out.push({
          kind: 'movie',
          title: m.title,
          detail: m.digitalRelease ? 'Digital release' : m.physicalRelease ? 'Physical release' : 'In cinemas',
          date,
          hasFile: m.hasFile === true,
        })
      }
    }

    out.sort((a, b) => a.date.localeCompare(b.date))
    return out
  })
}

// ── Overseerr requests ───────────────────────────────────────────────────────────────

export interface OverseerrStatus {
  configured: boolean
  // Overseerr media status enum: 1 unknown, 2 pending, 3 processing, 4 partially available, 5 available
  status: 'none' | 'pending' | 'processing' | 'partial' | 'available'
  requestable: boolean
  tmdbId: number | null
}

function mapStatus(n: number | undefined): OverseerrStatus['status'] {
  switch (n) {
    case 2: return 'pending'
    case 3: return 'processing'
    case 4: return 'partial'
    case 5: return 'available'
    default: return 'none'
  }
}

interface OverseerrSearchResult {
  results?: Array<{
    id?: number; mediaType?: string; title?: string; name?: string
    releaseDate?: string; firstAirDate?: string; posterPath?: string
    mediaInfo?: { status?: number }
  }>
}

export interface OverseerrCandidate {
  tmdbId: number
  title: string
  year: number | null
  posterUrl: string | null
  status: OverseerrStatus['status']
}

/** Best Overseerr search candidate for a title (used by request enrichment + companion confirm card). */
export async function overseerrSearch(title: string, year: number | null, mediaType: 'movie' | 'show'): Promise<OverseerrCandidate | null> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.overseerr_url || !cfg.overseerr_key) return null
  const wantType = mediaType === 'show' ? 'tv' : 'movie'
  const data = await overseerrFetch<OverseerrSearchResult>(cfg, `/search?query=${encodeURIComponent(title)}&page=1`)
  const candidates = (data?.results ?? []).filter((r) => r.mediaType === wantType && r.id)
  const match = candidates.find((r) => {
    const rTitle = (r.title ?? r.name ?? '').toLowerCase()
    if (rTitle !== title.toLowerCase()) return false
    if (year) {
      const rYear = Number((r.releaseDate ?? r.firstAirDate ?? '').slice(0, 4))
      if (rYear && Math.abs(rYear - year) > 1) return false
    }
    return true
  }) ?? candidates[0]
  if (!match?.id) return null
  const rYear = Number((match.releaseDate ?? match.firstAirDate ?? '').slice(0, 4)) || null
  return {
    tmdbId: match.id,
    title: match.title ?? match.name ?? title,
    year: rYear,
    posterUrl: match.posterPath ? `https://image.tmdb.org/t/p/w342${match.posterPath}` : null,
    status: mapStatus(match.mediaInfo?.status),
  }
}

async function overseerrFetch<T>(cfg: Record<IntegrationKey, string>, path: string, init?: RequestInit): Promise<T | null> {
  if (!cfg.overseerr_url || !cfg.overseerr_key) return null
  try {
    const res = await fetch(`${baseUrl(cfg.overseerr_url)}/api/v1${path}`, {
      ...init,
      headers: { 'X-Api-Key': cfg.overseerr_key, 'Content-Type': 'application/json', Accept: 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** Find a title on Overseerr (by name+year) and report its availability/request status. */
export async function overseerrStatus(title: string, year: number | null, mediaType: 'movie' | 'show'): Promise<OverseerrStatus> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.overseerr_url || !cfg.overseerr_key) return { configured: false, status: 'none', requestable: false, tmdbId: null }
  const wantType = mediaType === 'show' ? 'tv' : 'movie'
  const data = await overseerrFetch<OverseerrSearchResult>(cfg, `/search?query=${encodeURIComponent(title)}&page=1`)
  const match = (data?.results ?? []).find((r) => {
    if (r.mediaType !== wantType) return false
    const rTitle = (r.title ?? r.name ?? '').toLowerCase()
    if (rTitle !== title.toLowerCase()) return false
    if (year) {
      const rYear = Number((r.releaseDate ?? r.firstAirDate ?? '').slice(0, 4))
      if (rYear && Math.abs(rYear - year) > 1) return false
    }
    return true
  }) ?? (data?.results ?? []).find((r) => r.mediaType === wantType)
  if (!match?.id) return { configured: true, status: 'none', requestable: false, tmdbId: null }
  const status = mapStatus(match.mediaInfo?.status)
  return { configured: true, status, requestable: status === 'none', tmdbId: match.id }
}

/** Cheap connectivity probe for the admin Test button. */
export async function overseerrTest(): Promise<{ ok: boolean; version?: string }> {
  const cfg = await getIntegrationsConfig()
  if (!cfg.overseerr_url || !cfg.overseerr_key) return { ok: false }
  const status = await overseerrFetch<{ version?: string }>(cfg, '/status')
  return status ? { ok: true, version: status.version } : { ok: false }
}

/** File a request on Overseerr. For TV, requests all seasons. When overseerrUserId is given
 *  the request is filed on that user's behalf (Overseerr enforces their permissions/quotas):
 *  primary mechanism is `userId` in the body; if the server rejects that, retry with the
 *  X-API-User header (the Jellyseerr variant). Returns the created request id. */
export async function overseerrRequest(
  tmdbId: number,
  mediaType: 'movie' | 'show',
  overseerrUserId?: number,
): Promise<number | null> {
  const cfg = await getIntegrationsConfig()
  const base = mediaType === 'show'
    ? { mediaType: 'tv', mediaId: tmdbId, seasons: 'all' }
    : { mediaType: 'movie', mediaId: tmdbId }
  const body = overseerrUserId ? { ...base, userId: overseerrUserId } : base
  const res = await overseerrFetch<{ id?: number }>(cfg, '/request', { method: 'POST', body: JSON.stringify(body) })
  if (res?.id) return res.id
  if (overseerrUserId) {
    const retry = await overseerrFetch<{ id?: number }>(cfg, '/request', {
      method: 'POST', body: JSON.stringify(base), headers: { 'X-API-User': String(overseerrUserId) },
    })
    return retry?.id ?? null
  }
  return null
}

// ── Overseerr users + request list (per-user attribution and external-request sync) ──

export interface OverseerrUser { id: number; plexId: number | null; displayName: string | null }

export async function overseerrUsers(): Promise<OverseerrUser[]> {
  const cfg = await getIntegrationsConfig()
  const data = await overseerrFetch<{ results?: Array<{ id?: number; plexId?: number; displayName?: string; plexUsername?: string }> }>(cfg, '/user?take=200')
  return (data?.results ?? [])
    .filter((u) => u.id != null)
    .map((u) => ({ id: u.id!, plexId: u.plexId ?? null, displayName: u.displayName ?? u.plexUsername ?? null }))
}

export interface OverseerrRequestItem {
  requestId: number
  overseerrUserId: number | null
  plexId: number | null
  mediaType: 'movie' | 'show'
  tmdbId: number | null
  tvdbId: number | null
  /** Overseerr media status mapped via mapStatus. */
  status: OverseerrStatus['status']
  createdAt: string | null
}

/** Recent Overseerr requests (any user), newest first. */
export async function overseerrRequests(take = 100): Promise<OverseerrRequestItem[]> {
  const cfg = await getIntegrationsConfig()
  const data = await overseerrFetch<{ results?: Array<{
    id?: number; createdAt?: string; type?: string
    media?: { tmdbId?: number; tvdbId?: number; status?: number }
    requestedBy?: { id?: number; plexId?: number }
  }> }>(cfg, `/request?take=${take}&sort=added`)
  return (data?.results ?? [])
    .filter((r) => r.id != null)
    .map((r) => ({
      requestId: r.id!,
      overseerrUserId: r.requestedBy?.id ?? null,
      plexId: r.requestedBy?.plexId ?? null,
      mediaType: r.type === 'tv' ? 'show' as const : 'movie' as const,
      tmdbId: r.media?.tmdbId ?? null,
      tvdbId: r.media?.tvdbId ?? null,
      status: mapStatus(r.media?.status),
      createdAt: r.createdAt ?? null,
    }))
}

/** Status of a single Overseerr title by TMDB id (cheaper than search when the id is known). */
export async function overseerrStatusByTmdbId(tmdbId: number, mediaType: 'movie' | 'show'): Promise<OverseerrStatus['status'] | null> {
  const cfg = await getIntegrationsConfig()
  const path = mediaType === 'show' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`
  const data = await overseerrFetch<{ mediaInfo?: { status?: number } }>(cfg, path)
  if (!data) return null
  return mapStatus(data.mediaInfo?.status)
}
