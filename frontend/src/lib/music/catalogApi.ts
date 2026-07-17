// Frontend client for the music sub-app - catalog (MusicBrainz), AI stations, playlists, and
// library (favorites + history). Thin typed wrappers over the /api/music/* routes. (Track
// storage for Generate/Remix lives in ./api.)

import type { SuggestSource } from '@/lib/smartSearch/types'

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
  id: string; name: string; description: string | null; sourceRef: string | null; aiPrompt: string
  seedType: SeedType; seedValue: string | null; djMode: DjMode; visibility: Visibility
  accent: string | null; category: string | null; isBuiltin: boolean; owned: boolean; ownerName: string | null
  iconUrl: string | null; bannerUrl: string | null
  /** Lead track of the last built queue - cards resolve it to real album art. */
  coverTrack: { videoId: string; title: string; artist: string | null } | null
}
export interface StationBuckets { builtin: Station[]; mine: Station[]; shared: Station[]; categories: string[] }

export interface SmartRule { field: 'artist' | 'title' | 'genre' | 'plays' | 'lastPlayed' | 'favorite' | 'rating'; op: string; value?: string | number }
export interface SmartRules { match: 'all' | 'any'; limit?: number; sort?: 'plays' | 'recent' | 'rating' | 'title'; rules: SmartRule[] }
export interface Playlist {
  id: string; name: string; description: string | null; visibility: Visibility
  kind: 'manual' | 'magic' | 'smart' | 'blend'; rules: SmartRules | null
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
// Cover Art Archive front image for a release-group MBID (302s to the asset, 404s when none).
export function caaCoverUrl(releaseGroupMbid: string, size: 250 | 500 = 250): string {
  return `https://coverartarchive.org/release-group/${releaseGroupMbid}/front-${size}`
}
// Song search scoped by an optional band/artist so results aren't buried under covers.
export async function catalogSearchSongs(title: string, artist?: string): Promise<CatalogSong[]> {
  const params = new URLSearchParams({ type: 'songs', q: title.trim() })
  if (artist?.trim()) params.set('artist', artist.trim())
  const r = await mfetch<{ songs: CatalogSong[] }>(`/catalog/search?${params.toString()}`)
  return r.songs ?? []
}
// Query-autosuggest source for the SmartSearch header dropdown (artists + songs, Deezer-backed).
// Same shape/contract as youtubeSuggestSource so MusicLayout can drop it into useAppHeader.
export const musicSuggestSource: SuggestSource = async (query, signal) => {
  const r = await fetch(`/api/music/catalog/suggest?q=${encodeURIComponent(query)}`, { credentials: 'include', signal })
  const d = await r.json() as { suggestions?: Array<{ label: string; sublabel?: string }> }
  return (d.suggestions ?? []).map((s, i) => ({ id: String(i), label: s.label, sublabel: s.sublabel }))
}

export function getArtist(mbid: string) {
  return mfetch<{ artist: CatalogArtistDetail; albums: CatalogAlbum[] }>(`/catalog/artist/${mbid}`)
}
export function getAlbum(mbid: string) {
  return mfetch<{ album: CatalogAlbum; songs: CatalogSong[] }>(`/catalog/album/${mbid}`)
}
// Fallback cover art (iTunes) for albums with no Cover Art Archive image — called lazily only after
// the CAA image fails to load. Returns null when iTunes has nothing either.
export function getGenreLanding(genre: string) {
  return mfetch<{ tracks: Array<{ title: string; artist: string }>; artists: Array<{ name: string; picture: string | null }> }>(
    `/catalog/genre?g=${encodeURIComponent(genre)}`)
}
/** Bare artist name → THE MusicBrainz artist id (server-picked among same-named acts). */
export function getArtistId(name: string) {
  return mfetch<{ mbid: string | null }>(`/catalog/artist-id?name=${encodeURIComponent(name)}`)
}
/** Album title + artist → THE release-group MBID (Deezer search results have no MBID). */
export function getAlbumId(title: string, artist: string) {
  return mfetch<{ mbid: string | null }>(`/catalog/album-id?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`)
}
// Batch owned-copy lookup: which of these songs does the family's library (local/Plex)
// already have? Powers the "Yours" badges - a hit means playback uses the owned copy.
export function matchOwned(tracks: Array<{ title: string; artist: string; mbid?: string | null; durationSec?: number | null }>) {
  return mfetch<{ matches: Array<{ index: number; ref: string; source: 'local' | 'plex'; codec: string | null }> }>(
    '/catalog/match', { method: 'POST', body: JSON.stringify({ tracks }) })
}
export function getAlbumCoverFallback(artist: string, album: string) {
  return mfetch<{ coverUrl: string | null }>(
    `/catalog/cover?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&v=2`)
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
export function createStation(b: Partial<Station> & { coverImageUrl?: string }) {
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
export function createMagicPlaylist(b: { vibe: string; chips?: string[]; arc?: string; count?: number; name?: string }) {
  return mfetch<{ playlist: Playlist }>('/playlists/magic', { method: 'POST', body: body(b) })
}
export function regenerateMagicPlaylist(id: string) {
  return mfetch<{ ok: true; trackCount: number }>(`/playlists/${id}/regenerate`, { method: 'POST' })
}
export function createSmartPlaylist(b: { name: string; rules: SmartRules }) {
  return mfetch<{ playlist: Playlist }>('/playlists/smart', { method: 'POST', body: body(b) })
}
export function updateSmartRules(id: string, rules: SmartRules) {
  return mfetch<{ ok: true; count: number }>(`/playlists/${id}/rules`, { method: 'PUT', body: body({ rules }) })
}
export function previewSmartRules(rules: SmartRules) {
  return mfetch<{ count: number }>('/playlists/smart/preview', { method: 'POST', body: body({ rules }) })
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
export function recordHistory(h: { videoId: string; title: string; artist?: string; mbid?: string; stationId?: string; positionSec?: number; durationSec?: number }) {
  return mfetch<{ ok: true; id: string }>('/library/history', { method: 'POST', body: body(h) })
}
/** Progress beacon: how far the listener got. keepalive/sendBeacon-safe (fired on track
 *  change and page unload), so it uses raw fetch instead of mfetch. */
export function reportHistoryProgress(id: string, positionSec: number, durationSec?: number): void {
  const payload = JSON.stringify({ id, positionSec, durationSec })
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/music/library/history/progress', new Blob([payload], { type: 'application/json' }))
      return
    }
  } catch { /* fall through */ }
  void fetch('/api/music/library/history/progress', {
    method: 'POST', credentials: 'include', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: payload,
  }).catch(() => {})
}
export function getHistory(limit = 40) { return mfetch<{ history: HistoryItem[] }>(`/library/history?limit=${limit}`) }

// ── Made For You rails + Replay ─────────────────────────────────────────────────────
// `ref` (songKey) is set only on the interest-engine Suggested rail: the "Not interested" dismiss key.
export interface Rail { key: string; title: string; subtitle: string; tracks: Array<{ videoId: string; title: string; artist: string; ref?: string }> }
export function getRails() { return mfetch<{ rails: Rail[] }>('/rails') }
export interface Replay {
  year: number; totalPlays: number; totalMinutes: number
  topSongs: Array<{ videoId: string; title: string; artist: string; plays: number }>
  topArtists: Array<{ artist: string; plays: number }>
  topStations: Array<{ stationId: string; plays: number }>
  clock: number[]
  firstPlay: { title: string; artist: string; atMs: number } | null
}
export function getReplay(year?: number) { return mfetch<Replay>(`/rails/replay${year ? `?year=${year}` : ''}`) }

// ── Lyrics + song/artist info (Now-Playing panel) ───────────────────────────────────
// `words`, when present (Studio's forced-aligned lines only — raw LRCLIB never has it),
// times each individual word so the karaoke wipe can pace itself to real word durations.
export interface LyricWord { sec: number; end: number; text: string }
export interface LyricLine { sec: number; text: string; words?: LyricWord[] }
export function getLyrics(artist: string, title: string, duration?: number) {
  const p = new URLSearchParams({ artist, title })
  if (duration) p.set('duration', String(duration))
  return mfetch<{ synced: LyricLine[] | null; plain: string | null; source: string; restricted?: boolean }>(`/info/lyrics?${p}`)
}
export interface WikiInfo { found: boolean; title?: string; extract?: string; image?: string | null; url?: string | null; logo?: string | null }
export function getSongInfo(artist: string, title: string) {
  return mfetch<WikiInfo>(`/info/song?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`)
}
export function getArtistInfo(name: string, mbid?: string) {
  const p = new URLSearchParams({ q: name })
  if (mbid) p.set('mbid', mbid)
  return mfetch<WikiInfo>(`/info/artist?${p}`)
}

export interface PlatformLink { platform: string; url: string }
export function getSongSmartLinks(artist: string, track: string) {
  return mfetch<{ links: PlatformLink[] }>(`/info/smart-links?artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track)}`)
}
export function getAlbumSmartLinks(artist: string, album: string) {
  return mfetch<{ links: PlatformLink[] }>(`/info/smart-links?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`)
}

// ── Offline (audio saved for offline play) ──────────────────────────────────────────
export interface OfflineTrack { videoId: string; title: string; status: 'pending' | 'downloading' | 'ready' | 'failed'; sizeBytes: number | null }
export function listOffline() { return mfetch<{ offline: OfflineTrack[]; fileBase: string; stationVideoIds: string[] }>('/library/offline') }

/** Download audio quality. Each choice is a distinct shared asset server-side, so a household
 *  can hold the same song at two qualities without conflict. Sticky per device. */
export type AudioQuality = 'm4a' | 'mp3:320' | 'mp3:192' | 'opus:128'
export const AUDIO_QUALITIES: { id: AudioQuality; label: string; hint: string }[] = [
  { id: 'm4a', label: 'Original (M4A)', hint: 'Best quality, as delivered' },
  { id: 'mp3:320', label: 'MP3 320', hint: 'Plays anywhere' },
  { id: 'mp3:192', label: 'MP3 192', hint: 'Smaller files' },
  { id: 'opus:128', label: 'Opus 128', hint: 'Smallest, still sounds great' },
]
const QUALITY_KEY = 'music.downloadAudioQuality'
export function getDownloadAudioQuality(): AudioQuality {
  const raw = localStorage.getItem(QUALITY_KEY)
  return AUDIO_QUALITIES.some(q => q.id === raw) ? raw as AudioQuality : 'm4a'
}
export function setDownloadAudioQuality(q: AudioQuality) { localStorage.setItem(QUALITY_KEY, q) }

export function saveOffline(t: { videoId: string; title: string; audioFormat?: AudioQuality }) {
  return mfetch<{ status: string; id: string }>('/library/offline', { method: 'POST', body: body(t) })
}
export function removeOffline(videoId: string) {
  return mfetch<{ ok: true }>(`/library/offline/${encodeURIComponent(videoId)}`, { method: 'DELETE' })
}
export type OfflineMedia = 'audio' | 'video' | 'both'
export function snapshotStation(id: string, opts?: number | { count?: number; media?: OfflineMedia; maxHeight?: number; audioFormat?: AudioQuality }) {
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
// Resolve a station id to a ready-to-play DjStation (used by the controller surface and
// device button presses). Returns null if the id isn't among the user's visible stations.
export async function djStationById(id: string): Promise<DjStation | null> {
  const b = await listStations().catch(() => null)
  if (!b) return null
  const st = [...b.builtin, ...b.mine, ...b.shared].find((s) => s.id === id)
  return st ? stationToDj(st) : null
}

export function stationToDj(s: Station): DjStation {
  const accent = s.accent ?? 'violet'
  const [color, colorDark] = HEX[accent] ?? HEX.violet!
  return {
    id: s.id, label: s.name, emoji: EMOJI[accent] ?? '🎧', color, colorDark,
    stationId: s.id, aiPrompt: s.aiPrompt, seedType: s.seedType, seedValue: s.seedValue ?? undefined,
    djMode: s.djMode,
    sourceRef: s.sourceRef ?? undefined,
    iconUrl: s.iconUrl ?? undefined,
  }
}

/** Plexamp-style personal stations: queues built server-side from the listener's own
 *  history and favorites (Library Radio plays tracks they know; Deep Cuts and Time Travel
 *  steer the station engine off their listening profile). */
export type PersonalStationKind = 'library' | 'deep-cuts' | 'time-travel'
export const PERSONAL_STATIONS: { kind: PersonalStationKind; label: string; description: string; emoji: string; color: string; colorDark: string }[] = [
  // design-ok(hex-in-tsx): station identity colours, same contract as DJ_STATIONS presets
  { kind: 'library', label: 'Library Radio', description: 'A smart shuffle of the music you actually play', emoji: '📻', color: '#e5a00d', colorDark: '#b47c07' },
  { kind: 'deep-cuts', label: 'Deep Cuts', description: 'Album tracks and B-sides from your favorite artists', emoji: '💿', color: '#a855f7', colorDark: '#7c3aed' },
  { kind: 'time-travel', label: 'Time Travel Radio', description: 'Your artists, oldest recordings first, marching forward', emoji: '⏳', color: '#14b8a6', colorDark: '#0f766e' },
]
export function personalStationDj(kind: PersonalStationKind): DjStation {
  const p = PERSONAL_STATIONS.find(s => s.kind === kind)!
  return {
    id: `personal:${kind}`, label: p.label, emoji: p.emoji, color: p.color, colorDark: p.colorDark,
    personal: kind, djMode: 'full',
  }
}

// ── Sonic Adventure (Plexamp): a path of analyzed tracks from one song to another ──
export interface AdventureTrack { ref: string; title: string | null; artist: string | null }
export async function adventureStatus(): Promise<{ analyzed: number }> {
  return mfetch<{ analyzed: number }>('/stations/adventure/status')
}
export async function adventureSearch(q: string): Promise<AdventureTrack[]> {
  const r = await mfetch<{ results: AdventureTrack[] }>(`/stations/adventure/search?q=${encodeURIComponent(q)}`)
  return r.results
}
export function adventureStationDj(from: AdventureTrack, to: AdventureTrack): DjStation {
  return {
    id: `adventure:${from.ref}:${to.ref}`,
    label: `${from.title ?? 'Start'} → ${to.title ?? 'Destination'}`,
    // design-ok(hex-in-tsx): station identity colours, same contract as DJ_STATIONS presets
    emoji: '🧭', color: '#f43f5e', colorDark: '#be123c',
    adventure: { from: from.ref, to: to.ref },
    // A finite curated path - the DJ talking over it would break the arc.
    djMode: 'silent',
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
