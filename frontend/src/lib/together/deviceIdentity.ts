// Listening Together: this browser's stable player-device identity.
//
// The device id is minted once per browser profile and kept in localStorage - it is
// what presence heartbeats, the browser-session SSE registration, and remote
// commands all key on. The label is a human-readable default derived from the user
// agent ("Mac / Chrome"); users can override it with a persisted custom name
// (player_devices table) from the Devices popover.

import { uuid } from '@/lib/uuid'

const KEY = 'together.deviceId'

let cached: string | null = null

export function getDeviceId(): string {
  if (cached) return cached
  try {
    const existing = localStorage.getItem(KEY)
    if (existing && /^[a-zA-Z0-9_-]{8,64}$/.test(existing)) {
      cached = existing
      return existing
    }
    const fresh = uuid()
    localStorage.setItem(KEY, fresh)
    cached = fresh
    return fresh
  } catch {
    // Storage unavailable (rare): a per-page id still works, it just will not
    // survive a reload.
    if (!cached) cached = uuid()
    return cached
  }
}

/** Human-readable default label for this browser, e.g. "iPhone / Safari". */
export function getDeviceLabel(): string {
  const ua = navigator.userAgent
  let device = 'Computer'
  if (/iPhone/.test(ua)) device = 'iPhone'
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) device = 'iPad'
  else if (/Android/.test(ua) && /Mobile/.test(ua)) device = 'Android phone'
  else if (/Android/.test(ua)) device = 'Android tablet'
  else if (/Macintosh|Mac OS X/.test(ua)) device = 'Mac'
  else if (/Windows/.test(ua)) device = 'Windows PC'
  else if (/Linux/.test(ua)) device = 'Linux'

  let browser = 'browser'
  if (window.maipaiDesktop) browser = 'MaiPai Desktop'
  else if (/Edg\//.test(ua)) browser = 'Edge'
  else if (/OPR\//.test(ua)) browser = 'Opera'
  else if (/Chrome\//.test(ua)) browser = 'Chrome'
  else if (/Firefox\//.test(ua)) browser = 'Firefox'
  else if (/Safari\//.test(ua)) browser = 'Safari'

  return `${device} / ${browser}`
}
