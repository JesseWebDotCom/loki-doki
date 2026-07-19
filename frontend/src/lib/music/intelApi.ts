// Frontend client for /api/music/intel - the music-intelligence features built on the
// similarity engine: Track Radio, Mixes For You, Family Blend, Play Something, per-track
// tempo (AutoMix), and the offline auto-cache toggle.

export interface IntelTrack { videoId: string; title: string; artist: string }

async function ifetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/music/intel${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!res.ok) throw new Error(`music intel ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}
const body = (v: unknown) => JSON.stringify(v)

// ── Track Radio ─────────────────────────────────────────────────────────────────────
export function getTrackRadio(seed: { ref: string; title?: string; artist?: string | null }) {
  const p = new URLSearchParams({ ref: seed.ref })
  if (seed.title) p.set('title', seed.title)
  if (seed.artist) p.set('artist', seed.artist)
  return ifetch<{ tracks: IntelTrack[]; source: 'similarity' | 'station-engine' | 'empty' }>(`/track-radio?${p}`)
}

// ── Tempo facts for AutoMix (cached per ref; a miss is cached too) ───────────────────
export interface TempoFacts { bpm: number | null; keyLabel: string | null }
const tempoCache = new Map<string, TempoFacts | null>()
export async function getTempo(ref: string): Promise<TempoFacts | null> {
  if (tempoCache.has(ref)) return tempoCache.get(ref) ?? null
  try {
    const r = await ifetch<Record<string, TempoFacts>>(`/tempo?refs=${encodeURIComponent(ref)}`)
    const facts = r[ref] ?? null
    tempoCache.set(ref, facts)
    return facts
  } catch { return null }
}

// ── Mixes For You ───────────────────────────────────────────────────────────────────
export interface MixForYou {
  id: string
  key: string
  name: string
  subtitle: string | null
  tracks: IntelTrack[]
  /** Dismiss key for the suggestion-dismiss machinery (`mix:<key>`). */
  ref: string
}
export function getMixes() { return ifetch<{ mixes: MixForYou[] }>('/mixes') }

/** Shared factory for the Mixes-For-You rail (see lib/prefetch/registry). */
export function musicMixesQueryOptions() {
  return { queryKey: ['music-mixes'] as const, queryFn: getMixes, staleTime: 30 * 60 * 1000 }
}

// ── Family Blend ────────────────────────────────────────────────────────────────────
export interface Blend {
  id: string
  name: string
  ownerId: string
  members: Array<{ id: string; name: string }>
  playlistId: string
  matchPercent: number | null
  trackCount: number
  refreshedAt: number | null
  owned: boolean
  member: boolean
}
export function listBlends() { return ifetch<{ blends: Blend[] }>('/blends') }
export function createBlend(b: { memberIds: string[]; name?: string }) {
  return ifetch<{ blend: Blend }>('/blends', { method: 'POST', body: body(b) })
}
export function refreshBlend(id: string) {
  return ifetch<{ ok: true; trackCount: number; blend: Blend | null }>(`/blends/${id}/refresh`, { method: 'POST' })
}
export function deleteBlend(id: string) {
  return ifetch<{ ok: true }>(`/blends/${id}`, { method: 'DELETE' })
}

// ── Play Something ──────────────────────────────────────────────────────────────────
export type PlaySomethingChoice =
  | { kind: 'tracks'; name: string; reason: string; tracks: IntelTrack[] }
  | { kind: 'station'; stationId: string; reason: string }
export function playSomething() { return ifetch<{ choice: PlaySomethingChoice }>('/play-something') }

// ── Offline auto-cache ──────────────────────────────────────────────────────────────
export interface AutocacheStatus {
  enabled: boolean
  count: number
  total: number
  ready: number
  inProgress: number
  tracks: Array<{ videoId: string; title: string; artist: string | null; status: 'ready' | 'pending' | 'downloading' | 'failed' | 'missing' }>
}
export function getAutocache() { return ifetch<AutocacheStatus>('/autocache') }
export function setAutocache(b: { enabled?: boolean; count?: number }) {
  return ifetch<AutocacheStatus>('/autocache', { method: 'PUT', body: body(b) })
}

// ── Sonic Adventure path preview (rides the existing stations queue endpoint) ────────
export async function adventurePath(from: string, to: string): Promise<IntelTrack[]> {
  const res = await fetch('/api/music/stations/queue', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adventure: { from, to } }),
  })
  if (!res.ok) throw new Error(`adventure path -> ${res.status}`)
  const data = await res.json() as { tracks: Array<{ videoId: string; title: string; artist: string }> }
  return data.tracks
}
