import { instantStationDj } from '@/lib/music/catalogApi'
import type { DjStation } from '@/lib/music/radioStations'
import type { YtMiniTrack } from '@/context/YoutubePlaybackContext'
import { playNarrationTurns, type NarrationPlayTurn } from '@/lib/narration/playSession'

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
  channelThumb?: string | null
  thumbnail?: string | null
  durationSec?: number | null
  // station
  seedType?: 'artist' | 'song' | 'genre'
  seed?: string
}

/** Mirror of the backend `StartNarrationDirective` (tools/index.ts). Emitted when
 *  a companion tool detects speakers in a piece of text and wants the client to
 *  read it aloud with a distinct voice per speaker. */
export interface StartNarrationDirective {
  action: 'start_narration'
  sessionId: string
  turns: NarrationPlayTurn[]
}

export type Directive = PlayMediaDirective | StartNarrationDirective

export interface PlayDirectiveDeps {
  /** YoutubePlaybackContext.playExpanded — docks + expands one clip. */
  playExpanded: (t: YtMiniTrack) => void
  /** RadioContext.start — begins an AI radio station. */
  startStation: (s: DjStation, opts?: { silentIntro?: boolean }) => void
}

/** Parse an unknown SSE payload into a Directive, or null if it isn't one. */
export function parsePlayDirective(raw: unknown): Directive | null {
  if (!raw || typeof raw !== 'object') return null
  const action = (raw as { action?: string }).action
  if (action === 'start_narration') {
    const d = raw as Partial<StartNarrationDirective>
    if (!d.sessionId || !Array.isArray(d.turns)) return null
    return d as StartNarrationDirective
  }
  const d = raw as Partial<PlayMediaDirective>
  if (d.action !== 'play_media') return null
  if (d.media !== 'video' && d.media !== 'station') return null
  return d as PlayMediaDirective
}

/** Honor a play/narration directive. No navigation: playback starts wherever
 *  the user is (global mini-player, or the shared TTS playback singleton). */
export function applyPlayDirective(directive: Directive, deps: PlayDirectiveDeps): void {
  if (directive.action === 'start_narration') {
    void playNarrationTurns(directive.turns)
    return
  }
  if (directive.media === 'video' && directive.videoId) {
    deps.playExpanded({
      videoId: directive.videoId,
      title: directive.title ?? 'Now playing',
      author: directive.artist ?? null,
      channelThumb: directive.channelThumb ?? null,
      thumbnail: directive.thumbnail ?? undefined,
      durationSec: directive.durationSec ?? null,
    })
    return
  }
  if (directive.media === 'station' && directive.seed) {
    const type = directive.seedType === 'artist' ? 'artist' : directive.seedType === 'song' ? 'song' : 'genre'
    deps.startStation(instantStationDj({ type, value: directive.seed }), { silentIntro: true })
  }
}
