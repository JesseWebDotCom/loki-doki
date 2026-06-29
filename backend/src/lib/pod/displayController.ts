// Server-driven display orchestration for screen Pods.
//
// The device (Tab5 etc.) does nothing but poll ONE image URL and show it. The
// SERVER decides what that image is — so switching the screen between the ambient
// clock/weather page and a live camera feed is pure server-side logic, no device
// firmware changes and no "modes" for the device to track.
//
//   • Default ("auto")  → the rendered /display web frame (displayRenderer.ts).
//   • "camera" <url>    → live JPEG frames pulled from a camera (snapshot or MJPEG).
//                         Held until cleared (manual) or an optional timeout lapses.
//
// v1 is a MANUAL switch (Admin sets a device to a test camera URL) to prove the
// pipeline end-to-end. Automatic triggers (e.g. Frigate motion → door cam) layer on
// top later by calling setDeviceCamera() from an event source — no changes here.

interface DisplayState {
  mode: 'auto' | 'camera'
  cameraUrl: string | null
  until: number | null // epoch ms; null = until manually cleared
}

const state = new Map<string, DisplayState>() // deviceId → state

/** Resolve a device's CURRENT display intent, expiring a lapsed camera hold to auto. */
export function deviceDisplayMode(deviceId: string): { mode: 'auto' | 'camera'; cameraUrl: string | null } {
  const s = state.get(deviceId)
  if (!s || s.mode !== 'camera' || !s.cameraUrl) return { mode: 'auto', cameraUrl: null }
  if (s.until != null && Date.now() > s.until) {
    state.delete(deviceId)
    return { mode: 'auto', cameraUrl: null }
  }
  return { mode: 'camera', cameraUrl: s.cameraUrl }
}

/** Put a camera full-screen on a device. `holdMs` optional (omit = until cleared). */
export function setDeviceCamera(deviceId: string, cameraUrl: string, holdMs?: number): void {
  state.set(deviceId, { mode: 'camera', cameraUrl, until: holdMs ? Date.now() + holdMs : null })
}

/** Return a device to the ambient clock/weather page. */
export function setDeviceAuto(deviceId: string): void {
  state.delete(deviceId)
}

// ── Controller view ──────────────────────────────────────────────────────────────
// Which server-rendered view the device currently shows: the ambient layout ('display')
// or the button-grid controller ('controller'). The device reports this on a swipe; the
// render/stream loop renders the matching /display?view= URL. Independent of camera mode.
const viewState = new Map<string, 'display' | 'controller'>() // deviceId → view

export function deviceView(deviceId: string): 'display' | 'controller' {
  return viewState.get(deviceId) ?? 'display'
}

export function setDeviceView(deviceId: string, view: 'display' | 'controller'): void {
  if (view === 'controller') viewState.set(deviceId, view)
  else viewState.delete(deviceId)
}

const SOI = Buffer.from([0xff, 0xd8]) // JPEG start-of-image
const EOI = Buffer.from([0xff, 0xd9]) // JPEG end-of-image
const MJPEG_MAX_BYTES = 3_000_000

/** Grab a single JPEG frame from a camera URL. Handles both a plain snapshot
 *  (…/latest.jpg) and an MJPEG multipart stream (extract the first complete frame). */
export async function fetchCameraFrame(url: string): Promise<Buffer | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!r.ok || !r.body) return null
    const ct = (r.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('multipart')) {
      return Buffer.from(await r.arrayBuffer()) // snapshot JPEG
    }
    // MJPEG: read until one full JPEG is buffered, then stop the stream.
    const reader = r.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (total < MJPEG_MAX_BYTES) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          total += value.length
        }
        const buf = Buffer.concat(chunks)
        const start = buf.indexOf(SOI)
        if (start >= 0) {
          const end = buf.indexOf(EOI, start + 2)
          if (end >= 0) return buf.subarray(start, end + 2)
        }
      }
    } finally {
      try { await reader.cancel() } catch { /* ignore */ }
    }
    return null
  } catch {
    return null
  }
}
