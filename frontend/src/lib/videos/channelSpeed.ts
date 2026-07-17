// Per-channel playback-speed memory: 1.5x for the lecture channel, 1x for music, without
// re-picking every video. Nobody ships this (YouTube's speed resets per video), and it is
// the single most-requested power-user player feature in the alt-frontend communities.
//
// Device-local on purpose: playback speed is an ergonomic preference for THIS screen (a
// phone in the kitchen vs a TV), not an account-level truth, so it stays in localStorage
// rather than syncing through user_preferences.

const KEY = 'videos.channelSpeed'

type SpeedMap = Record<string, number>

function read(): SpeedMap {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? parsed as SpeedMap : {}
  } catch { return {} }
}

/** Remembered rate for a channel/creator, or null when it has never been set. */
export function getChannelSpeed(channelKey: string | null | undefined): number | null {
  if (!channelKey) return null
  const v = read()[channelKey]
  return typeof v === 'number' && v > 0 ? v : null
}

/** Remember (or forget, at 1x) the rate for a channel. */
export function setChannelSpeed(channelKey: string | null | undefined, rate: number): void {
  if (!channelKey) return
  const map = read()
  if (rate === 1) delete map[channelKey]
  else map[channelKey] = rate
  try { localStorage.setItem(KEY, JSON.stringify(map)) } catch { /* quota / private mode */ }
}
