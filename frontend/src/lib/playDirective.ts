import { instantStationDj } from '@/lib/music/catalogApi'
import type { DjStation } from '@/lib/music/radioStations'
import type { YtMiniTrack } from '@/context/YoutubePlaybackContext'

/** Mirror of the backend `PlayMediaDirective` (tools/index.ts). Emitted over the
 *  chat/companion SSE stream as a `directive` event so the companion can start
 *  playback in the global mini-player. */
export interface PlayMediaDirective {
  action: 'play_media'
  media: 'video' | 'station'
  // video
  videoId?: string
  title?: string
  artist?: string | null
  thumbnail?: string | null
  durationSec?: number | null
  // station
  seedType?: 'artist' | 'song' | 'genre'
  seed?: string
}

export interface PlayDirectiveDeps {
  /** YoutubePlaybackContext.playExpanded — docks + expands one clip. */
  playExpanded: (t: YtMiniTrack) => void
  /** RadioContext.start — begins an AI radio station. */
  startStation: (s: DjStation) => void
}

/** Parse an unknown SSE payload into a PlayMediaDirective, or null if it isn't one. */
export function parsePlayDirective(raw: unknown): PlayMediaDirective | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Partial<PlayMediaDirective>
  if (d.action !== 'play_media') return null
  if (d.media !== 'video' && d.media !== 'station') return null
  return d as PlayMediaDirective
}

/** Honor a play directive by driving the global mini-player. No navigation —
 *  playback starts wherever the user is. */
export function applyPlayDirective(directive: PlayMediaDirective, deps: PlayDirectiveDeps): void {
  if (directive.media === 'video' && directive.videoId) {
    deps.playExpanded({
      videoId: directive.videoId,
      title: directive.title ?? 'Now playing',
      author: directive.artist ?? null,
      thumbnail: directive.thumbnail ?? undefined,
      durationSec: directive.durationSec ?? null,
    })
    return
  }
  if (directive.media === 'station' && directive.seed) {
    const type = directive.seedType === 'artist' ? 'artist' : directive.seedType === 'song' ? 'song' : 'genre'
    deps.startStation(instantStationDj({ type, value: directive.seed }))
  }
}
