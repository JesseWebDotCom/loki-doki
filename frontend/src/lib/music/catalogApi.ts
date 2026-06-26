// Frontend client for the music sub-app — catalog (MusicBrainz), AI stations, playlists, and
// library (favorites + history). Thin typed wrappers over the /api/music/* routes. (Track
// storage for Generate/Remix lives in ./api.)

// ── Shared shapes (mirror the backend serializers) ────────────────────────────────
export interface CatalogArtist {
  mbid: string; name: string; disambiguation: string | null; type: string | null; country: string | null
}
export interface CatalogAlbum {
  mbid: string; title: string; primaryType: string | null; secondaryTypes: string[]
  firstReleaseDate: string | null; year: number | null; artistName: string; artistMbid: string | null; coverUrl: string | null
}
export interface CatalogSong {
  mbid: string; title: string; durationSec: number | null; artistName: string
  artistMbid: string | null; albumTitle: string | null; albumMbid: string | null
}
export interface CatalogArtistDetail extends CatalogArtist {
  wikipediaUrl: string | null; wikidataId: string | null; officialUrl: string | null; tags: string[]
}
export interface ResolvedTrack {
  videoId: string; title: string; artist: string; durationSec: number | null; score: number
}

export type DjMode = 'full' | 'minimal' | 'silent'
export type SeedType = 'prompt' | 'genre' | 'artist' | 'song'
export type Visibility = 'private' | 'shared'

export interface Station {
  id: string; name: string; description: string | null; aiPrompt: string
  seedType: SeedType; seedValue: string | null; djMode: DjMode; visibility: Visibility
  accent: string | null; category: string | null; isBuiltin: boolean; owned: boolean; ownerName: string | null
  iconUrl: string | null; bannerUrl: string | null
}
export interface StationBuckets { builtin: Station[]; mine: Station[]; shared: Station[]; categories: string[] }

export interface Playlist {
  id: string; name: string; description: string | null; visibility: Visibility
  owned: boolean; ownerName: string | null; trackCount: number; coverUrl: string | null
}
export interface PlaylistTrack {
  id: string; playlistId: string; mbid: string | null; videoId: string; title: string
  artist: string | null; durationSec: number | null; position: number
}
export interface Favorite {
  id: string; kind: 'song' | 'station' | 'playlist'; refId: string
  title: string | null; artist: string | null; mbid: string | null
}
export interface HistoryItem {
  id: string; videoId: string; mbid: string | null; title: string; artist: string | null
  stationId: string | null; positionSec: number
}

// ── fetch helper ──────────────────────────────────────────────────────────────────
async function mfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/music${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!res.ok) throw new Error(`music ${path} → ${res.status}`)
  return res.json() as Promise<T>
}
const body = (v: unknown) => JSON.stringify(v)

// ── Catalog ─────────────────────────────────────────────────────────────────────
export function catalogSearch(q: string, type: 'all' | 'artists' | 'albums' | 'songs' | 'stations' = 'all') {
  return mfetch<{ artists: CatalogArtist[]; albums: CatalogAlbum[]; songs: CatalogSong[]; stations: Station[] }>(
    `/catalog/search?q=${encodeURIComponent(q)}&type=${type}`)
}
export function getArtist(mbid: string) {
  return mfetch<{ artist: CatalogArtistDetail; albums: CatalogAlbum[] }>(`/catalog/artist/${mbid}`)
}
export function getAlbum(mbid: string) {
  return mfetch<{ album: CatalogAlbum; songs: CatalogSong[] }>(`/catalog/album/${mbid}`)
}
export async function resolveSong(s: { mbid?: string | null; title: string; artist: string; durationSec?: number | null }) {
  const params = new URLSearchParams({ title: s.title, artist: s.artist })
  if (s.mbid) params.set('mbid', s.mbid)
  if (s.durationSec) params.set('duration', String(s.durationSec))
  const r = await mfetch<{ resolved: ResolvedTrack | null }>(`/catalog/resolve?${params}`)
  return r.resolved
}

// ── Stations ────────────────────────────────────────────────────────────────────
export function listStations() { return mfetch<StationBuckets>('/stations') }
export function getStation(id: string) { return mfetch<{ station: Station }>(`/stations/${id}`) }
export function getStationTuning(id: string) { return mfetch<{ messages: string[] }>(`/stations/${id}/tuning`) }
export function previewStationQueue(stationId: string, count = 12) {
  return mfetch<{ tracks: ResolvedTrack[]; source: string }>('/stations/queue', { method: 'POST', body: body({ stationId, count }) })
}
export function createStation(b: Partial<Station>) {
  return mfetch<{ station: Station }>('/stations', { method: 'POST', body: body(b) })
}
export function updateStation(id: string, b: Partial<Station>) {
  return mfetch<{ station: Station }>(`/stations/${id}`, { method: 'PATCH', body: body(b) })
}
export function deleteStation(id: string) {
  return mfetch<{ ok: true }>(`/stations/${id}`, { method: 'DELETE' })
}
export function shareStation(id: string, shared: boolean) {
  return mfetch<{ visibility: Visibility }>(`/stations/${id}/share`, { method: 'POST', body: body({ shared }) })
}
export function cloneStation(id: string) {
  return mfetch<{ station: Station }>(`/stations/${id}/clone`, { method: 'POST' })
}
export function regenerateStationArt(id: string) {
  return mfetch<{ iconUrl: string | null; bannerUrl: string | null }>(`/stations/${id}/regenerate-art`, { method: 'POST' })
}

// ── Playlists ───────────────────────────────────────────────────────────────────
export function listPlaylists() { return mfetch<{ mine: Playlist[]; shared: Playlist[] }>('/playlists') }
export function getPlaylist(id: string) { return mfetch<{ playlist: Playlist; tracks: PlaylistTrack[] }>(`/playlists/${id}`) }
export function createPlaylist(b: { name: string; description?: string; visibility?: Visibility }) {
  return mfetch<{ playlist: Playlist }>('/playlists', { method: 'POST', body: body(b) })
}
export function updatePlaylist(id: string, b: Partial<Pick<Playlist, 'name' | 'description' | 'visibility'>>) {
  return mfetch<{ playlist: Playlist }>(`/playlists/${id}`, { method: 'PATCH', body: body(b) })
}
export function deletePlaylist(id: string) { return mfetch<{ ok: true }>(`/playlists/${id}`, { method: 'DELETE' }) }
export function addPlaylistTrack(id: string, t: { videoId: string; title: string; artist?: string; mbid?: string; durationSec?: number }) {
  return mfetch<{ ok: true }>(`/playlists/${id}/tracks`, { method: 'POST', body: body(t) })
}
export function removePlaylistTrack(id: string, trackId: string) {
  return mfetch<{ ok: true }>(`/playlists/${id}/tracks/${trackId}`, { method: 'DELETE' })
}
export function reorderPlaylist(id: string, trackIds: string[]) {
  return mfetch<{ ok: true }>(`/playlists/${id}/tracks/order`, { method: 'PUT', body: body({ trackIds }) })
}
export function sharePlaylist(id: string, shared: boolean) {
  return mfetch<{ visibility: Visibility }>(`/playlists/${id}/share`, { method: 'POST', body: body({ shared }) })
}
export function clonePlaylist(id: string) {
  return mfetch<{ playlist: Playlist }>(`/playlists/${id}/clone`, { method: 'POST' })
}

// ── Library (favorites + history) ──────────────────────────────────────────────────
export function getFavorites(kind?: Favorite['kind']) {
  return mfetch<{ favorites: Favorite[] }>(`/library/favorites${kind ? `?kind=${kind}` : ''}`)
}
export function addFavorite(f: { kind: Favorite['kind']; refId: string; title?: string; artist?: string; mbid?: string }) {
  return mfetch<{ ok: true }>('/library/favorites', { method: 'PUT', body: body(f) })
}
export function removeFavorite(kind: Favorite['kind'], refId: string) {
  return mfetch<{ ok: true }>(`/library/favorites/${kind}/${encodeURIComponent(refId)}`, { method: 'DELETE' })
}
export function recordHistory(h: { videoId: string; title: string; artist?: string; mbid?: string; stationId?: string; positionSec?: number }) {
  return mfetch<{ ok: true }>('/library/history', { method: 'POST', body: body(h) })
}
export function getHistory(limit = 40) { return mfetch<{ history: HistoryItem[] }>(`/library/history?limit=${limit}`) }

// ── Lyrics + song/artist info (Now-Playing panel) ───────────────────────────────────
export interface LyricLine { sec: number; text: string }
export function getLyrics(artist: string, title: string, duration?: number) {
  const p = new URLSearchParams({ artist, title })
  if (duration) p.set('duration', String(duration))
  return mfetch<{ synced: LyricLine[] | null; plain: string | null; source: string }>(`/info/lyrics?${p}`)
}
export interface WikiInfo { found: boolean; title?: string; extract?: string; image?: string | null; url?: string | null }
export function getSongInfo(artist: string, title: string) {
  return mfetch<WikiInfo>(`/info/song?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`)
}
export function getArtistInfo(name: string, mbid?: string) {
  const p = new URLSearchParams({ q: name })
  if (mbid) p.set('mbid', mbid)
  return mfetch<WikiInfo>(`/info/artist?${p}`)
}

// ── Offline (audio saved for offline play) ──────────────────────────────────────────
export interface OfflineTrack { videoId: string; title: string; status: 'pending' | 'downloading' | 'ready' | 'failed'; sizeBytes: number | null }
export function listOffline() { return mfetch<{ offline: OfflineTrack[]; fileBase: string; stationVideoIds: string[] }>('/library/offline') }
export function saveOffline(t: { videoId: string; title: string }) {
  return mfetch<{ status: string; id: string }>('/library/offline', { method: 'POST', body: body(t) })
}
export function removeOffline(videoId: string) {
  return mfetch<{ ok: true }>(`/library/offline/${encodeURIComponent(videoId)}`, { method: 'DELETE' })
}
export type OfflineMedia = 'audio' | 'video' | 'both'
export function snapshotStation(id: string, opts?: number | { count?: number; media?: OfflineMedia; maxHeight?: number }) {
  const payload = typeof opts === 'number' ? { count: opts } : (opts ?? {})
  return mfetch<{ offlineStationId: string; queued: number; total: number }>(`/stations/${id}/snapshot`, { method: 'POST', body: body(payload) })
}
export const offlineAudioUrl = (videoId: string) => `/api/youtube/file/${videoId}/audio`

/** Video-quality config (tiers/cap/pref) — shared with the YouTube app's save-quality governance. */
export interface VideoSaveQuality { tiers: number[]; cap: number; pref: number | null; effective: number }
export async function getVideoSaveQuality(): Promise<VideoSaveQuality> {
  const res = await fetch('/api/youtube/save-quality', { credentials: 'include' })
  if (!res.ok) throw new Error(`save-quality → ${res.status}`)
  return res.json() as Promise<VideoSaveQuality>
}

// ── Offline stations (a whole station saved for full offline use) ────────────────────
export interface OfflineStatus {
  status: 'pending' | 'partial' | 'ready' | 'failed'
  tracksReady: number; trackTotal: number; djReady: number; djTotal: number
  media?: OfflineMedia; videoReady?: number
}
/** A saved-offline station: a normal Station card plus its live download/DJ readiness. */
export interface OfflineStation extends Station { offline: OfflineStatus }

export function listOfflineStations() {
  return mfetch<{ stations: OfflineStation[] }>('/stations/offline')
}
export function getOfflineStatus(stationId: string) {
  return mfetch<{ saved: boolean } & Partial<OfflineStatus>>(`/stations/${stationId}/offline-status`)
}
export type DlStatus = 'pending' | 'downloading' | 'ready' | 'failed'
export interface OfflineTrackRow { videoId: string; title: string; artist: string | null; position: number; status: DlStatus; videoStatus?: DlStatus | null }
export function getOfflineTracks(stationId: string) {
  return mfetch<{ tracks: OfflineTrackRow[] }>(`/stations/${stationId}/offline-tracks`)
}
export interface OfflineVideoQueue { tracks: { videoId: string; title: string; author: string }[] }
export function getOfflineVideoQueue(stationId: string) {
  return mfetch<OfflineVideoQueue>(`/stations/${stationId}/offline-video-queue`)
}
export interface OfflineDjSeg { text: string; audioUrl: string }
export interface OfflineQueue {
  tracks: { videoId: string; title: string; author: string; audioUrl: string }[]
  dj: { intro: OfflineDjSeg | null; outro: OfflineDjSeg | null; transitions: Record<string, OfflineDjSeg> }
}
export function getOfflineQueue(stationId: string) {
  return mfetch<OfflineQueue>(`/stations/${stationId}/offline-queue`)
}
export function removeOfflineStation(stationId: string) {
  return mfetch<{ ok: true }>(`/stations/${stationId}/offline`, { method: 'DELETE' })
}

// ── Prefetch cache (transient download-ahead for gapless playback) ───────────────────
/** Fire-and-forget: ask the server to download-ahead a track (next video, handoff other-media). */
export function prefetchMedia(videoId: string, kind: 'audio' | 'video', maxHeight?: number) {
  return mfetch<{ ok: true }>('/library/prefetch', { method: 'POST', body: body({ videoId, kind, maxHeight }) }).catch(() => {})
}
/** Which of these videoIds are locally ready for `kind` (prefetched OR saved) → can play offline. */
export async function prefetchReady(videoIds: string[], kind: 'audio' | 'video'): Promise<string[]> {
  if (!videoIds.length) return []
  const r = await mfetch<{ ready: string[] }>(`/library/prefetch?kind=${kind}&ids=${encodeURIComponent(videoIds.join(','))}`).catch(() => ({ ready: [] }))
  return r.ready
}

// ── Adapt a Station into the radio engine's DjStation shape ─────────────────────────
import type { DjStation } from '@/lib/music/radioStations'
const EMOJI: Record<string, string> = {
  violet: '🎧', blue: '🎵', cyan: '🎛️', emerald: '🌿', amber: '🎸', rose: '💗', fuchsia: '🎤', slate: '🌙',
}
const HEX: Record<string, [string, string]> = {
  violet: ['#6d28d9', '#a78bfa'], blue: ['#1d4ed8', '#60a5fa'], cyan: ['#0e7490', '#22d3ee'],
  emerald: ['#047857', '#34d399'], amber: ['#b45309', '#fbbf24'], rose: ['#be123c', '#fb7185'],
  fuchsia: ['#a21caf', '#e879f9'], slate: ['#334155', '#94a3b8'],
}
export function stationToDj(s: Station): DjStation {
  const accent = s.accent ?? 'violet'
  const [color, colorDark] = HEX[accent] ?? HEX.violet!
  return {
    id: s.id, label: s.name, emoji: EMOJI[accent] ?? '🎧', color, colorDark,
    stationId: s.id, aiPrompt: s.aiPrompt, seedType: s.seedType, seedValue: s.seedValue ?? undefined,
    djMode: s.djMode,
  }
}

/** An ephemeral "instant station" seeded by an artist, song, genre, or freeform prompt
 *  (Apple-Music style). artist/song ride YouTube Music's radio mix; genre/prompt drive the
 *  AI station engine off the text. */
export function instantStationDj(seed: { type: 'artist' | 'song' | 'genre' | 'prompt'; value: string; label?: string }): DjStation {
  const isEntity = seed.type === 'artist' || seed.type === 'song'
  return {
    id: `instant:${seed.type}:${seed.value}`, label: seed.label ?? seed.value, emoji: '⚡',
    color: '#6d28d9', colorDark: '#a78bfa',
    aiPrompt: isEntity ? `Songs like ${seed.value}` : seed.value,
    seedType: isEntity ? seed.type : (seed.type === 'genre' ? 'genre' : 'prompt'),
    seedValue: isEntity ? seed.value : undefined,
    djMode: 'full',
  }
}
