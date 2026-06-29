// Per-user "now playing" snapshot, reported by the browser's radio player and read by the
// controller surface so a screen device (rendered in a separate headless tab that can't see
// the user's player) can show the active station, play/pause state, and progress.

export interface NowPlaying {
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
