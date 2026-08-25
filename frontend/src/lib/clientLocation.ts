// Best-effort device coordinates for chat/companion requests, so the backend
// can tell where the user actually IS (traveling vs the saved home); see
// backend/src/lib/currentLocation.ts. Never blocks a send: returns the cached
// fix (or nulls) synchronously and refreshes in the background. Falls through
// to nulls on insecure contexts (remote http origins have no geolocation API)
// and denied permission; the backend then relies on the request's IANA
// timezone, which every surface always sends.

let fix: { lat: number; lng: number; at: number } | null = null
let pending = false
let failedAt = 0
const MAX_AGE_MS = 10 * 60 * 1000
const FAIL_COOLDOWN_MS = 15 * 60 * 1000

// React surfaces (weather widgets) need to re-read when a background fix lands -
// getClientCoords is deliberately synchronous, so notify subscribers on updates.
const listeners = new Set<() => void>()

/** Subscribe to coordinate-fix updates. Returns the unsubscribe function. */
export function subscribeClientCoords(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Cached device coordinates, refreshing in the background. The first call on a
 *  device without a stored grant triggers the browser's permission prompt (the
 *  send itself proceeds with nulls; later sends carry the fix). Keys match the
 *  chat request body so callers can spread the result in. */
export function getClientCoords(): { clientLat: number | null; clientLng: number | null } {
  void refreshCoords()
  return fix ? { clientLat: fix.lat, clientLng: fix.lng } : { clientLat: null, clientLng: null }
}

/** Warm the cache at app load WITHOUT prompting: only fetches when permission
 *  was already granted (e.g. via Maps or Settings → detect my location). */
export function prewarmClientCoords(): void {
  if (!canGeolocate()) return
  navigator.permissions
    ?.query({ name: 'geolocation' })
    .then((p) => { if (p.state === 'granted') void refreshCoords() })
    .catch(() => { /* permissions API unavailable; wait for the first send */ })
}

function canGeolocate(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'geolocation' in navigator
}

async function refreshCoords(): Promise<void> {
  if (pending) return
  if (fix && Date.now() - fix.at < MAX_AGE_MS) return
  if (failedAt && Date.now() - failedAt < FAIL_COOLDOWN_MS) return
  if (!canGeolocate()) return
  pending = true
  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        maximumAge: 5 * 60 * 1000,
        timeout: 8000,
      }),
    )
    fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, at: Date.now() }
    failedAt = 0
    for (const fn of listeners) fn()
  } catch {
    // Denied or unavailable; cool down so a denial doesn't retry every message.
    failedAt = Date.now()
  } finally {
    pending = false
  }
}
