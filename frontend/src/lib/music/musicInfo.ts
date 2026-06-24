export interface ArtistInfo {
  found: boolean
  title?: string
  extract?: string
  image?: string | null
  url?: string | null
}

export interface SoundtrackAppearance {
  title: string
  year: string | null
  type: 'movie' | 'show' | 'soundtrack'
}

export interface TrackInfo {
  appearances: SoundtrackAppearance[]
}

export interface SoundtrackSong {
  title: string
  durationMs: number | null
}

export interface SoundtrackInfo {
  songs: SoundtrackSong[]
  sourceTitle?: string
}

export async function fetchArtistInfo(name: string): Promise<ArtistInfo> {
  try {
    const res = await fetch(`/api/music/info/artist?q=${encodeURIComponent(name)}`, {
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { found: false }
    return await res.json() as ArtistInfo
  } catch {
    return { found: false }
  }
}

export async function fetchTrackAppearances(artist: string, track: string): Promise<SoundtrackAppearance[]> {
  try {
    const res = await fetch(
      `/api/music/info/track?artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track)}`,
      { credentials: 'include', signal: AbortSignal.timeout(10000) },
    )
    if (!res.ok) return []
    const data = await res.json() as TrackInfo
    return data.appearances ?? []
  } catch {
    return []
  }
}

export async function fetchShowSoundtrack(showTitle: string): Promise<SoundtrackInfo> {
  try {
    const res = await fetch(`/api/music/info/soundtrack?title=${encodeURIComponent(showTitle)}`, {
      credentials: 'include',
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return { songs: [] }
    return await res.json() as SoundtrackInfo
  } catch {
    return { songs: [] }
  }
}
