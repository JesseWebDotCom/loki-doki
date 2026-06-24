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

async function plexGet<T>(conn: PlexConnection, path: string): Promise<T | null> {
  try {
    const sep = path.includes('?') ? '&' : '?'
    const res = await fetch(`${conn.baseUrl}${path}${sep}X-Plex-Token=${encodeURIComponent(conn.token)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
}
interface PlexContainer {
  MediaContainer?: { machineIdentifier?: string; Metadata?: PlexMeta[] }
}

let _machineId: string | null | undefined
async function machineId(conn: PlexConnection): Promise<string | null> {
  if (_machineId !== undefined) return _machineId
  const data = await plexGet<PlexContainer>(conn, '/identity')
  _machineId = data?.MediaContainer?.machineIdentifier ?? null
  return _machineId
}

function deepLink(mid: string | null, ratingKey: string): string | null {
  if (!mid) return null
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`)
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

export async function recentlyAdded(conn: PlexConnection, limit = 20): Promise<PlexLibraryItem[]> {
  const data = await plexGet<PlexContainer>(conn, `/library/recentlyAdded?X-Plex-Container-Size=${limit}&X-Plex-Container-Start=0`)
  const metas = data?.MediaContainer?.Metadata ?? []
  const mid = await machineId(conn)
  const items: PlexLibraryItem[] = []
  for (const m of metas) {
    if (!m.ratingKey) continue
    const type = m.type === 'movie' ? 'movie' : m.type === 'show' ? 'show' : null
    if (!type) continue
    items.push({
      ratingKey: m.ratingKey,
      title: m.title ?? '',
      year: m.year ?? null,
      type,
      thumbUrl: m.thumb ? `${conn.baseUrl}${m.thumb}?X-Plex-Token=${encodeURIComponent(conn.token)}` : null,
      deepLink: deepLink(mid, m.ratingKey),
    })
    if (items.length >= limit) break
  }
  return items
}

// Best-effort add to the account Watchlist (discover.provider.plex.tv). Requires the token to
// be a Plex account token and the item to carry a plex:// GUID. Returns false on any failure.
export async function addToPlexWatchlist(conn: PlexConnection, plexGuid: string): Promise<boolean> {
  const ratingKey = plexGuid.replace(/^plex:\/\//, '')
  if (!ratingKey) return false
  try {
    const res = await fetch(
      `https://discover.provider.plex.tv/actions/addToWatchlist?ratingKey=${encodeURIComponent(ratingKey)}&X-Plex-Token=${encodeURIComponent(conn.token)}`,
      { method: 'PUT', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    )
    return res.ok
  } catch {
    return false
  }
}
