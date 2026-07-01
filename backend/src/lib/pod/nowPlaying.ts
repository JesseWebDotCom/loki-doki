// Per-user "now playing" snapshot, reported by the browser's radio player and read by the
// controller surface so a screen device (rendered in a separate headless tab that can't see
// the user's player) can show the active station, play/pause state, and progress.

export type NowPlayingSource = 'radio' | 'youtube' | 'podcast'

export interface NowPlaying {
  source: NowPlayingSource
  /** Client-minted id for THIS play session — a new value every time playback starts fresh
   *  (including skipping to the next track), reused for every report until it stops. Lets
   *  the device re-show a dismissed bar on a genuine new play (even a replayed track, where
   *  title/videoId alone wouldn't change), and — critically — lets a stop/clear request only
   *  take effect if it's still clearing the session it thinks it is. A source-only guard isn't
   *  enough: closing podcast A and immediately starting podcast B is still "podcast", so a
   *  slow-arriving clear for A could otherwise wipe out B's now-playing entry after the fact. */
  sessionId: string
  stationId: string | null
  videoId: string | null   // when a single track/video is playing (not a station)
  title: string
  artist: string | null
  cover: string         // album/track art URL ('' when none)
  positionSec: number
  durationSec: number
  playing: boolean      // active && !paused
  updatedAt: number     // epoch ms (server clock)
}

const store = new Map<string, NowPlaying>() // userId → snapshot
const STALE_MS = 5 * 60 * 1000

export function setNowPlaying(userId: string, np: Omit<NowPlaying, 'updatedAt'>): void {
  store.set(userId, { ...np, updatedAt: Date.now() })
}

export function getNowPlaying(userId: string): NowPlaying | null {
  const np = store.get(userId)
  if (!np) return null
  if (Date.now() - np.updatedAt > STALE_MS) { store.delete(userId); return null }
  return np
}

/** A source announcing it has fully stopped (the ✕ / close, or losing audio focus with
 *  nothing queued behind it). Only clears if the snapshot is STILL this exact session — if
 *  a newer session (same source or a different one) has since taken over, the clear is a
 *  no-op instead of wiping out state that's since moved on. */
export function clearNowPlaying(userId: string, source: NowPlayingSource, sessionId: string): void {
  const cur = store.get(userId)
  if (cur && cur.source === source && cur.sessionId === sessionId) store.delete(userId)
}

// ── Plex activity slot ────────────────────────────────────────────────────────────
// Separate from the music/YouTube now-playing since Plex is polled server-side (no
// browser push); displayed in the 'activity' view on screen Pods.

export interface PlexActivity {
  title: string
  showTitle: string | null   // parent show name for episodes; null for movies
  type: 'movie' | 'episode' | 'other'
  thumb: string | null       // relative Plex path — proxy through /api/plex/img?path=…
  progress: number | null    // 0–1 viewOffset/duration
  state: string | null       // 'playing' | 'paused' | 'buffering'
  updatedAt: number
}

const plexStore = new Map<string, PlexActivity>() // userId → snapshot
const PLEX_STALE_MS = 2 * 60 * 1000 // 2-min TTL; poller refreshes every ~30s

export function setPlexActivity(userId: string, a: Omit<PlexActivity, 'updatedAt'>): void {
  plexStore.set(userId, { ...a, updatedAt: Date.now() })
}

export function clearPlexActivity(userId: string): void {
  plexStore.delete(userId)
}

export function getPlexActivity(userId: string): PlexActivity | null {
  const a = plexStore.get(userId)
  if (!a) return null
  if (Date.now() - a.updatedAt > PLEX_STALE_MS) { plexStore.delete(userId); return null }
  return a
}
