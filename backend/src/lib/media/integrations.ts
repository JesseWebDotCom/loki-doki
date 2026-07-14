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
] as const
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number]

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
    releaseDate?: string; firstAirDate?: string
    mediaInfo?: { status?: number }
  }>
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

/** File a request on Overseerr. For TV, requests all seasons. */
export async function overseerrRequest(tmdbId: number, mediaType: 'movie' | 'show'): Promise<boolean> {
  const cfg = await getIntegrationsConfig()
  const body = mediaType === 'show'
    ? { mediaType: 'tv', mediaId: tmdbId, seasons: 'all' }
    : { mediaType: 'movie', mediaId: tmdbId }
  const res = await overseerrFetch<{ id?: number }>(cfg, '/request', { method: 'POST', body: JSON.stringify(body) })
  return !!res?.id
}
