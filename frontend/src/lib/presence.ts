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

// Curated quick-set presets shown in the sidebar's status switcher and in
// Settings → Profile. A subset of the full StatusState space — the rest
// (on_call, in_meeting, away, custom) are set via companion/API, not this UI.
// Hex values are presence-state data rendered via inline styles, not UI accents.
// design-ok(hex-in-tsx): status preset color data
export const STATUS_PRESETS = [
  { state: 'available', label: 'Available', color: '#22c55e' },
  { state: 'busy',      label: 'Busy',      color: '#ef4444' },
  { state: 'focusing',  label: 'Focusing',  color: '#3b82f6' },
  { state: 'dnd',       label: 'DND',       color: '#7c3aed' },
  { state: 'brb',       label: 'BRB',       color: '#eab308' },
] as const
