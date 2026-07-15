import { instantStationDj } from '@/lib/music/catalogApi'
import type { DjStation } from '@/lib/music/radioStations'
import type { YtMiniTrack } from '@/context/YoutubePlaybackContext'
import { playNarrationTurns, type NarrationPlayTurn } from '@/lib/narration/playSession'
import { openFromDirective } from '@/lib/canvas/artifactStore'

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

/** Mirror of the backend `OpenArtifactDirective` (tools/index.ts). Emitted when the
 *  companion creates a Canvas artifact so the client opens the pane (over any app,
 *  even with chat closed). The body streams in afterwards via artifact_token events. */
export interface OpenArtifactDirective {
  action: 'open_artifact'
  artifactId: string
  artifactType: 'code' | 'document' | 'html'
  title: string
}

/** Mirror of the backend `ConfirmActionDirective` (tools/index.ts). Emitted when a
 *  tool STAGED an action (send, delete, unlock...) and is asking for confirmation.
 *  Surfaces render approve/decline buttons; either re-enters the turn with a
 *  canonical 'Yes'/'No'. Handled by the stream consumers BEFORE applyPlayDirective
 *  (chat derives a block, the engine sets pendingAction). */
export interface ConfirmActionDirective {
  action: 'confirm_action'
  actionId: string
  summary: string
  approveLabel: string
  declineLabel: string
  /** Optional rich preview (poster + "Title (Year)") rendered above the buttons. */
  card?: { title: string; subtitle?: string; imageUrl?: string }
}

/** Mirror of the backend `OpenPlaylistDirective` (tools/index.ts). Emitted when the
 *  companion's curate_playlist tool builds or refines a saved playlist. The shell opens
 *  the playlist page so the user sees it; `autoplay` is currently false by design
 *  (curating shouldn't hijack whatever audio is going) but is honored if set. */
export interface OpenPlaylistDirective {
  action: 'open_playlist'
  playlistId: string
  name: string
  trackCount: number
  autoplay?: boolean
}

export type Directive = PlayMediaDirective | StartNarrationDirective | OpenArtifactDirective | ConfirmActionDirective | OpenPlaylistDirective

export interface PlayDirectiveDeps {
  /** YoutubePlaybackContext.playExpanded - docks + expands one clip. */
  playExpanded: (t: YtMiniTrack) => void
  /** RadioContext.start - begins an AI radio station. */
  startStation: (s: DjStation, opts?: { silentIntro?: boolean }) => void
  /** Open (and optionally play) a saved playlist the companion just curated.
   *  Optional: only the router-mounted shell supplies it; in-chat dispatch omits it. */
  openPlaylist?: (playlistId: string, opts: { name: string; trackCount: number; autoplay: boolean }) => void
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
  if (action === 'open_artifact') {
    const d = raw as Partial<OpenArtifactDirective>
    if (!d.artifactId || !d.artifactType) return null
    return d as OpenArtifactDirective
  }
  if (action === 'confirm_action') {
    const d = raw as Partial<ConfirmActionDirective>
    if (!d.actionId || !d.summary) return null
    return {
      action: 'confirm_action',
      actionId: d.actionId,
      summary: d.summary,
      approveLabel: d.approveLabel || 'Yes',
      declineLabel: d.declineLabel || 'Cancel',
      ...(d.card?.title ? { card: d.card } : {}),
    }
  }
  if (action === 'open_playlist') {
    const d = raw as Partial<OpenPlaylistDirective>
    if (!d.playlistId) return null
    return {
      action: 'open_playlist',
      playlistId: d.playlistId,
      name: d.name || 'Playlist',
      trackCount: typeof d.trackCount === 'number' ? d.trackCount : 0,
      autoplay: !!d.autoplay,
    }
  }
  const d = raw as Partial<PlayMediaDirective>
  if (d.action !== 'play_media') return null
  if (d.media !== 'video' && d.media !== 'station') return null
  return d as PlayMediaDirective
}

/** Honor a play/narration directive. No navigation: playback starts wherever
 *  the user is (global mini-player, or the shared TTS playback singleton). */
export function applyPlayDirective(directive: Directive, deps: PlayDirectiveDeps): void {
  if (directive.action === 'confirm_action') {
    // Surface state, not a playback action: the stream consumers (ChatContext
    // block derivation, CompanionEngineContext pendingAction) handle it before
    // delegating here. No-op by design.
    return
  }
  if (directive.action === 'open_artifact') {
    // The canvas store is a global singleton, so this works whether or not the chat
    // page (and its deps) are mounted - the pane floats over the current app.
    openFromDirective(directive)
    return
  }
  if (directive.action === 'start_narration') {
    void playNarrationTurns(directive.turns)
    return
  }
  if (directive.action === 'open_playlist') {
    // Only the router-mounted shell supplies openPlaylist (it has navigation); in-chat
    // dispatch omits it, so the spoken confirmation stands on its own there.
    deps.openPlaylist?.(directive.playlistId, {
      name: directive.name,
      trackCount: directive.trackCount,
      autoplay: directive.autoplay ?? false,
    })
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
      // This directive is only emitted by the companion's play_music tool (video vs AI
      // station), so it must not pollute the Videos hub's watch history.
      origin: 'music',
    })
    return
  }
  if (directive.media === 'station' && directive.seed) {
    const type = directive.seedType === 'artist' ? 'artist' : directive.seedType === 'song' ? 'song' : 'genre'
    deps.startStation(instantStationDj({ type, value: directive.seed }), { silentIntro: true })
  }
}
