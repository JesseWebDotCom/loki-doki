// Music Studio API client. Plain fetch + credentials, mirroring lib/music/api.ts.

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

export interface StudioBeat { time: number; downbeat?: boolean }
export interface StudioChord { startTime: number; endTime: number; label: string }
export interface StudioStem { name: string; url: string }

export type AnalysisStatus = 'none' | 'pending' | 'analyzing' | 'ready' | 'failed'
export type StemStatus = 'none' | 'pending' | 'separating' | 'ready' | 'failed'
export type SourceStatus = 'ready' | 'fetching' | 'failed'
export type LyricsAlignStatus = 'none' | 'pending' | 'aligning' | 'ready' | 'failed'
export type StemModel = '2-stem' | '4-stem' | '6-stem'
export interface StudioLyricWord { sec: number; end: number; text: string }
// `words`, when present, times each individual word (from forced alignment) so the karaoke
// wipe can pace itself to real word durations instead of interpolating across the whole line.
export interface StudioLyricLine { sec: number; text: string; words?: StudioLyricWord[] }

export interface StudioTrack {
  id: string
  title: string
  artist: string | null
  durationSec: number | null
  sourceStatus: SourceStatus
  sourceError: string | null
  analysisStatus: AnalysisStatus
  analysisError: string | null
  bpm: number | null
  keyLabel: string | null
  beats: StudioBeat[]
  chords: StudioChord[]
  stemStatus: StemStatus
  stemModel: StemModel | null
  stemError: string | null
  stems: StudioStem[]
  coverUrl: string | null
  // Lyrics re-timed to this track's own vocals via forced alignment. When status is 'ready',
  // `lyrics` holds the corrected [{sec, text}] and the UI uses it instead of raw LRCLIB.
  lyricsAlignStatus: LyricsAlignStatus
  lyrics: StudioLyricLine[]
  createdAt: number
  updatedAt: number
  // Live percent for the in-flight job (only present on the single-track GET).
  stemProgress?: { pct: number; note?: string } | null
  sourceProgress?: { pct: number; note?: string } | null
}

export async function listStudioTracks(): Promise<{ installed: boolean; guitarEnhanced?: boolean; tracks: StudioTrack[] }> {
  const r = await fetch('/api/music/studio', opts)
  if (!r.ok) throw new Error('list')
  return await r.json() as { installed: boolean; guitarEnhanced?: boolean; tracks: StudioTrack[] }
}

export async function getStudioTrack(id: string): Promise<{ installed: boolean; guitarEnhanced?: boolean; track: StudioTrack }> {
  const r = await fetch(`/api/music/studio/${id}`, opts)
  if (!r.ok) throw new Error('get')
  return await r.json() as { installed: boolean; guitarEnhanced?: boolean; track: StudioTrack }
}

export async function uploadStudioTrack(file: File, meta: { title?: string; artist?: string } = {}): Promise<string> {
  const fd = new FormData()
  fd.append('audio', file, file.name)
  if (meta.title) fd.append('title', meta.title)
  if (meta.artist) fd.append('artist', meta.artist)
  const r = await fetch('/api/music/studio/upload', { ...opts, method: 'POST', body: fd })
  if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error ?? 'upload')
  return (await r.json() as { id: string }).id
}

export async function createStudioFromCatalog(pick: { mbid?: string; videoId?: string; albumMbid?: string | null; albumTitle?: string | null; title: string; artist?: string; durationSec?: number | null }): Promise<string> {
  const r = await fetch('/api/music/studio/from-catalog', { ...opts, method: 'POST', headers: J, body: JSON.stringify(pick) })
  if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error ?? 'add')
  return (await r.json() as { id: string }).id
}

export async function reanalyzeStudioTrack(id: string): Promise<void> {
  const r = await fetch(`/api/music/studio/${id}/analyze`, { ...opts, method: 'POST' })
  if (!r.ok) throw new Error('analyze')
}

/** Re-run lyric forced-alignment (needs a vocals stem). Normally auto-runs after separation. */
export async function alignStudioLyrics(id: string): Promise<void> {
  const r = await fetch(`/api/music/studio/${id}/align`, { ...opts, method: 'POST' })
  if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error ?? 'align')
}

export type CustomStem = 'vocals' | 'drums' | 'bass' | 'guitar' | 'piano' | 'other'

export async function generateStems(id: string, req: { model?: StemModel; stems?: CustomStem[]; enhancedGuitar?: boolean }): Promise<void> {
  const r = await fetch(`/api/music/studio/${id}/stems`, { ...opts, method: 'POST', headers: J, body: JSON.stringify(req) })
  if (!r.ok) throw new Error('stems')
}

export async function deleteStudioTrack(id: string): Promise<void> {
  const r = await fetch(`/api/music/studio/${id}`, { ...opts, method: 'DELETE' })
  if (!r.ok) throw new Error('delete')
}

/** Karaoke: find-or-create a stem-separated (vocals + instrumental) track for a song and
 *  return its studio-track id. Reuses an existing separation for the same videoId. Poll it
 *  with getStudioTrack(id) until stemStatus === 'ready', then play the stems. */
export async function prepareKaraoke(song: { videoId: string; title: string; artist?: string | null; durationSec?: number | null }): Promise<string> {
  const r = await fetch('/api/music/studio/karaoke/prepare', { ...opts, method: 'POST', headers: J, body: JSON.stringify(song) })
  if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error ?? 'prepare')
  return (await r.json() as { id: string }).id
}

export interface KaraokeSuggestion { title: string; artist: string; cover: string | null }
/** Curated popular karaoke standards (with cover art) for the suggestions row. */
export async function getKaraokeSuggestions(): Promise<KaraokeSuggestion[]> {
  const r = await fetch('/api/music/studio/karaoke/suggestions', opts)
  if (!r.ok) return []
  return (await r.json() as { suggestions: KaraokeSuggestion[] }).suggestions
}

export interface KaraokeReadySong {
  id: string; title: string; artist: string | null
  videoId: string | null; durationSec: number | null; coverUrl: string | null
}
/** Songs already stem-separated on the server (survive restarts) — re-singing is instant. */
export async function getKaraokeReady(): Promise<KaraokeReadySong[]> {
  const r = await fetch('/api/music/studio/karaoke/ready', opts)
  if (!r.ok) return []
  return (await r.json() as { songs: KaraokeReadySong[] }).songs
}
