// Mutual exclusion for app-wide audio sources. Each media context registers a
// stop callback; any source that wants exclusive audio calls acquireAudio() first.
//
// It also tracks the ACTIVE source and its transport controls, so a remote (e.g. a Tab5
// native player bar → server → useBrowserSession) can drive whichever engine is playing.

type StopFn = () => void
export interface Transport {
  toggle: () => void
  next: () => void
  prev: () => void
  seek: (sec: number) => void
  stop: () => void
}

type MediaSource = 'radio' | 'youtube' | 'podcast' | 'liveRadio'

const stops: Partial<Record<MediaSource, StopFn>> = {}
const transports: Partial<Record<MediaSource, Transport>> = {}
let active: MediaSource | null = null

export function registerMediaStop(kind: MediaSource, fn: StopFn): () => void {
  stops[kind] = fn
  return () => { if (stops[kind] === fn) delete stops[kind] }
}

export function acquireAudio(source: MediaSource): void {
  active = source
  for (const [kind, fn] of Object.entries(stops) as [string, StopFn][]) {
    if (kind !== source) fn()
  }
}

/** An engine registers its transport controls; the most-recently-acquired one is active. */
export function registerTransport(kind: MediaSource, t: Transport): () => void {
  transports[kind] = t
  return () => { if (transports[kind] === t) delete transports[kind] }
}

/** True once an engine has claimed audio in this tab. Deliberately sticky (engines
 *  don't report their own stop): used to keep the remote-control SSE stream alive in a
 *  hidden tab that has been playing, so a device remote can still drive it. */
export function hasActiveMedia(): boolean {
  return active !== null
}

/** Route a remote transport command to the active engine. */
export function dispatchTransport(action: string, position?: number): void {
  const t = active ? transports[active] : null
  if (!t) return
  if (action === 'toggle' || action === 'play' || action === 'pause') t.toggle()
  else if (action === 'next') t.next()
  else if (action === 'prev') t.prev()
  else if (action === 'seek' && typeof position === 'number') t.seek(position)
  else if (action === 'stop') t.stop()
}
