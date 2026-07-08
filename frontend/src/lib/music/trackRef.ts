// Unified music track reference (frontend twin of backend/src/lib/music/trackRef.ts).
// Every "videoId" carried through queues/playlists/favorites/history is really a ref:
//
//   `dQw4w9WgXcQ`                      bare (no ':')  → YouTube video id (all legacy data)
//   `local:<trackId>`                                 → local library file
//   `plex:<machineId>:<ratingKey>`                    → Plex server track
//
// All three stream through same-origin /api routes, so the Web Audio analyser/DSP graph
// stays untainted regardless of source.

import { proxyStreamUrl, ytImageProxy } from '@/lib/youtube/api'

export type TrackSource = 'youtube' | 'plex' | 'local'

export type ParsedRef =
  | { source: 'youtube'; videoId: string }
  | { source: 'local'; localId: string }
  | { source: 'plex'; machineId: string; ratingKey: string }

export const isYouTubeRef = (ref: string): boolean => !ref.includes(':')
export const localRef = (id: string): string => `local:${id}`
export const plexRef = (machineId: string, ratingKey: string): string => `plex:${machineId}:${ratingKey}`

export function parseTrackRef(ref: string): ParsedRef {
  if (!ref.includes(':')) return { source: 'youtube', videoId: ref }
  const [head, ...rest] = ref.split(':')
  if (head === 'local' && rest.length >= 1) return { source: 'local', localId: rest.join(':') }
  if (head === 'plex' && rest.length >= 2) {
    const ratingKey = rest[rest.length - 1]!
    return { source: 'plex', machineId: rest.slice(0, -1).join(':'), ratingKey }
  }
  return { source: 'youtube', videoId: ref }
}

export const trackSource = (ref: string): TrackSource => parseTrackRef(ref).source

/** Same-origin streaming URL for any ref (audio). */
export function streamSrcForRef(ref: string): string {
  const p = parseTrackRef(ref)
  switch (p.source) {
    case 'youtube': return proxyStreamUrl(p.videoId, 'audio')
    case 'local': return `/api/music/collection/local/stream/${encodeURIComponent(p.localId)}`
    case 'plex': return `/api/plex/music/stream/${encodeURIComponent(p.ratingKey)}`
  }
}

/** Artwork URL for any ref. YouTube uses the proxied video thumbnail; local uses the
 *  library art endpoint; Plex needs the track's thumb path passed through the img proxy. */
export function artUrlForRef(ref: string, plexThumb?: string | null): string | null {
  const p = parseTrackRef(ref)
  switch (p.source) {
    case 'youtube': return ytImageProxy(`https://i.ytimg.com/vi/${p.videoId}/hqdefault.jpg`)
    case 'local': return `/api/music/collection/local/art/${encodeURIComponent(p.localId)}`
    case 'plex': return plexThumb ? `/api/plex/img?path=${encodeURIComponent(plexThumb)}` : null
  }
}
