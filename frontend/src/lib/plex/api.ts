// Typed wrappers around /api/plex/*. Everything degrades to "not configured / not present"
// so the UI can call freely and just hide Plex affordances when absent.

const opts: RequestInit = { credentials: 'include' }

export interface PlexMatch {
  present: boolean
  ratingKey: string | null
  title: string | null
  year: number | null
  type: 'movie' | 'show' | null
  deepLink: string | null
  guids: string[]
}

export interface PlexStatus {
  configured: boolean // this user has a working connection (own token, or shared fallback)
  ok: boolean
  serverName: string | null
  linked?: boolean // whether THIS user linked their own Plex account (vs. the shared fallback)
  serverConfigured?: boolean // whether an admin set up the shared server at all
}

export interface PlexPoster {
  to: string
  title: string
  subtitle: string | null
  poster: string | null
  mediaType: 'movie' | 'show'
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

export async function getPlexStatus(): Promise<PlexStatus> {
  const res = await fetch('/api/plex/status', opts)
  if (!res.ok) return { configured: false, ok: false, serverName: null }
  return (await res.json()) as PlexStatus
}

// One of the resolved library rails: recently added, on-deck, or Plex's own recommendations.
export async function getPlexRail(kind: 'recent' | 'ondeck' | 'hubs', type: 'movie' | 'show'): Promise<PlexPoster[]> {
  const res = await fetch(`/api/plex/${kind}?type=${type}`, opts)
  if (!res.ok) return []
  const data = (await res.json()) as { items: PlexPoster[] }
  return data.items ?? []
}

export async function getPlexSessions(): Promise<PlexSession[]> {
  const res = await fetch('/api/plex/sessions', opts)
  if (!res.ok) return []
  const data = (await res.json()) as { sessions: PlexSession[] }
  return data.sessions ?? []
}

export async function findInPlex(params: {
  type: 'movie' | 'show'
  title: string
  year?: number | null
  imdb?: string | null
  tvdb?: number | null
}): Promise<PlexMatch> {
  const qs = new URLSearchParams({ type: params.type, title: params.title })
  if (params.year) qs.set('year', String(params.year))
  if (params.imdb) qs.set('imdb', params.imdb)
  if (params.tvdb) qs.set('tvdb', String(params.tvdb))
  const res = await fetch(`/api/plex/find?${qs}`, opts)
  if (!res.ok) {
    return { present: false, ratingKey: null, title: null, year: null, type: null, deepLink: null, guids: [] }
  }
  return (await res.json()) as PlexMatch
}

export interface PlexPlaybackMeta {
  ratingKey: string
  title: string
  container: string | null
  videoCodec: string | null
  audioCodec: string | null
  durationMs: number | null
  directPlay: boolean
}

export async function getPlexMeta(ratingKey: string): Promise<PlexPlaybackMeta | null> {
  const res = await fetch(`/api/plex/meta/${encodeURIComponent(ratingKey)}`, opts)
  if (!res.ok) return null
  return (await res.json()) as PlexPlaybackMeta
}

export function plexStreamUrl(ratingKey: string): string {
  return `/api/plex/stream/${encodeURIComponent(ratingKey)}`
}

// ── Skip intro/credits + scrubber previews ───────────────────────────────────────
// Both derive from the file itself server-side (ffprobe chapters / an ffmpeg keyframe
// pass), so they work without Plex Pass. See backend/src/lib/videos/mediaSegments.ts.

export interface MediaSegment {
  type: 'intro' | 'credits' | 'recap' | 'preview' | 'sponsor'
  startSec: number
  endSec: number
}

export interface TrickplayInfo {
  url: string
  intervalSec: number
  cols: number
  rows: number
  tileWidth: number
  tileHeight: number
  totalCount: number
}

export async function getPlexSegments(ratingKey: string): Promise<MediaSegment[]> {
  const r = await fetch(`/api/plex/segments/${encodeURIComponent(ratingKey)}`, { credentials: 'include' })
  if (!r.ok) return []
  return (await r.json() as { segments: MediaSegment[] }).segments ?? []
}

export async function getPlexTrickplay(ratingKey: string): Promise<TrickplayInfo | null> {
  const r = await fetch(`/api/plex/trickplay/${encodeURIComponent(ratingKey)}`, { credentials: 'include' })
  if (!r.ok) return null
  return (await r.json() as { trickplay: TrickplayInfo | null }).trickplay ?? null
}

// ── admin: PIN auth + server discovery + config ──────────────────────────────────

export interface PlexPin {
  id: number
  code: string
  clientId: string
  linkUrl: string
}
export interface PlexServer {
  name: string
  uri: string
  local: boolean
}
export interface PlexConfigSummary {
  baseUrl: string
  hasToken: boolean
  users: Array<{
    id: string
    name: string
    /** Signed in with their own Plex account (needed for personal watchlist/scrobble sync). */
    linked: boolean
    /** Admin-side mapping to a Plex account (enough to provision/share libraries). */
    plexAccountId: string | null
    plexUsername: string | null
  }>
}

/** A Plex account visible to the server admin (owner, friends, Plex Home users). */
export interface PlexKnownAccount {
  id: string
  name: string
  username: string | null
  email: string | null
  owner: boolean
  restricted: boolean
}

export async function getPlexAccounts(): Promise<PlexKnownAccount[]> {
  const res = await fetch('/api/plex/admin/accounts', opts)
  if (!res.ok) return []
  return ((await res.json()) as { accounts: PlexKnownAccount[] }).accounts ?? []
}

export async function setPlexUserMapping(userId: string, account: { id: string; username: string | null } | null): Promise<boolean> {
  const res = await fetch('/api/plex/admin/user-mapping', {
    ...opts,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, plexAccountId: account?.id ?? null, plexUsername: account?.username ?? null }),
  })
  return res.ok
}

// Current-user linking (per-user account). Reuses the PIN flow above.
export interface MyPlexStatus {
  linked: boolean
  ok: boolean
  serverName: string | null
}

export async function getMyPlex(): Promise<MyPlexStatus> {
  const res = await fetch('/api/plex/me', opts)
  if (!res.ok) return { linked: false, ok: false, serverName: null }
  return (await res.json()) as MyPlexStatus
}

export async function linkMyPlex(token: string): Promise<MyPlexStatus> {
  const res = await fetch('/api/plex/me/link', {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) return { linked: false, ok: false, serverName: null }
  return (await res.json()) as MyPlexStatus
}

export async function unlinkMyPlex(): Promise<void> {
  await fetch('/api/plex/me', { ...opts, method: 'DELETE' })
}

export async function startPlexPin(): Promise<PlexPin | null> {
  const res = await fetch('/api/plex/auth/pin', { ...opts, method: 'POST' })
  if (!res.ok) return null
  return (await res.json()) as PlexPin
}

export async function pollPlexPin(id: number, clientId: string): Promise<string | null> {
  const res = await fetch(`/api/plex/auth/pin/${id}?clientId=${encodeURIComponent(clientId)}`, opts)
  if (!res.ok) return null
  return ((await res.json()) as { authToken: string | null }).authToken
}

export async function discoverPlexServers(token: string, clientId: string): Promise<PlexServer[]> {
  const res = await fetch('/api/plex/auth/discover', {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, clientId }),
  })
  if (!res.ok) return []
  return ((await res.json()) as { servers: PlexServer[] }).servers ?? []
}

export async function getPlexConfig(): Promise<PlexConfigSummary | null> {
  const res = await fetch('/api/plex/config', opts)
  if (!res.ok) return null
  return (await res.json()) as PlexConfigSummary
}

export async function savePlexConfig(patch: { baseUrl?: string; token?: string }): Promise<{ ok: boolean; serverName: string | null }> {
  const res = await fetch('/api/plex/config', {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) return { ok: false, serverName: null }
  const data = (await res.json()) as { ok: boolean; serverName: string | null }
  return { ok: data.ok, serverName: data.serverName }
}

// ── Exported video libraries (per-user per-source) + sync policies ────────────────

export const PLEX_EXPORT_SOURCES = [
  { key: 'youtube', label: 'YouTube' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'vimeo', label: 'Vimeo' },
  { key: 'reddit', label: 'Reddit' },
  { key: 'mine', label: 'My Videos' },
] as const
export type PlexExportSource = (typeof PLEX_EXPORT_SOURCES)[number]['key']

export interface PlexLibrarySection {
  id: string
  userId: string
  contentType: string
  status: 'pending' | 'provisioning' | 'ready' | 'error'
  error: string | null
  syncMode: 'all' | 'recent'
  syncRecentCount: number | null
  removeWatched: boolean
}

export interface LibraryPolicyPatch {
  syncMode?: 'all' | 'recent'
  syncRecentCount?: number | null
  removeWatched?: boolean
}

export async function getAdminLibrarySections(): Promise<PlexLibrarySection[]> {
  const res = await fetch('/api/plex/admin/library-sections', opts)
  if (!res.ok) return []
  return ((await res.json()) as { sections: PlexLibrarySection[] }).sections ?? []
}

export interface MyLibrarySections {
  sections: PlexLibrarySection[]
  /** Per-contentType: admin has assigned a storage location WITH a Plex path mapping —
   *  the prerequisite for provisioning. Lets the settings page show unprovisioned sources
   *  disabled with the right "what's missing" note instead of hiding them. */
  storageReady: Record<string, boolean>
}

export async function getMyLibrarySections(): Promise<MyLibrarySections> {
  const res = await fetch('/api/plex/me/library-sections', opts)
  if (!res.ok) return { sections: [], storageReady: {} }
  const data = (await res.json()) as Partial<MyLibrarySections>
  return { sections: data.sections ?? [], storageReady: data.storageReady ?? {} }
}

export async function provisionLibrary(userId: string, contentType: string): Promise<boolean> {
  const res = await fetch('/api/plex/admin/provision', {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, contentType }),
  })
  return res.ok
}

export async function patchMyLibraryPolicy(contentType: string, patch: LibraryPolicyPatch): Promise<string | null> {
  const res = await fetch(`/api/plex/me/library-sections/${encodeURIComponent(contentType)}`, {
    ...opts,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (res.ok) return null
  return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not update the policy'
}

export async function patchAdminLibraryPolicy(sectionId: string, patch: LibraryPolicyPatch): Promise<string | null> {
  const res = await fetch(`/api/plex/admin/library-sections/${encodeURIComponent(sectionId)}`, {
    ...opts,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  if (res.ok) return null
  return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not update the policy'
}

export async function addToPlexWatchlist(plexGuid: string): Promise<boolean> {
  const res = await fetch('/api/plex/watchlist', {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plexGuid }),
  })
  if (!res.ok) return false
  const data = (await res.json()) as { ok: boolean }
  return data.ok
}
