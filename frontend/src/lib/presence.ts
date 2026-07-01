// Shared types for the per-user presence API (/api/pod/presence).
// Must stay in sync with backend/src/lib/pod/presence.ts.

export type StatusState =
  | 'available' | 'busy' | 'dnd' | 'on_call'
  | 'in_meeting' | 'focusing' | 'brb' | 'away' | 'custom'

export interface UserStatus {
  state: StatusState
  label: string
  color: string
  timerEndsAt: number | null
  source: 'manual' | 'companion' | 'api'
  setAt: number
}

export interface SleepConfig {
  active: boolean
  dimBrightness: number
  ambientSound: 'rain' | 'white_noise' | 'ocean' | 'fan' | null
  ambientVolume: number
  source: 'manual' | 'companion' | 'schedule'
  setAt: number
}

export interface NowPlaying {
  stationId: string | null
  videoId: string | null
  title: string
  artist: string | null
  cover: string
  positionSec: number
  durationSec: number
  playing: boolean
  updatedAt: number
}

export interface PlexActivity {
  title: string
  showTitle: string | null
  type: 'movie' | 'episode' | 'other'
  thumb: string | null
  progress: number | null
  state: string | null
  updatedAt: number
}

export interface Alert {
  emoji: string
  message: string
  color: string
  source: string
  expiresAt: number
}

export interface UserPresence {
  status: UserStatus | null
  sleep: SleepConfig | null
  nowPlaying: NowPlaying | null
  plexActivity: PlexActivity | null
  alert: Alert | null
}
