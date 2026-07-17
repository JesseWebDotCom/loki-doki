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
  // Optional volume controls — engines that own a mixer register these so a remote
  // (controller button, voice) can adjust the volume of whatever is playing locally.
  volumeUp?: () => void
  volumeDown?: () => void
  toggleMute?: () => void
}

export type MediaSource = 'radio' | 'youtube' | 'podcast' | 'liveRadio' | 'studio'

const stops: Partial<Record<MediaSource, StopFn>> = {}
const transports: Partial<Record<MediaSource, Transport>> = {}
let active: MediaSource | null = null
const sourceListeners = new Set<() => void>()

export function registerMediaStop(kind: MediaSource, fn: StopFn): () => void {
  stops[kind] = fn
  return () => { if (stops[kind] === fn) delete stops[kind] }
}

export function acquireAudio(source: MediaSource): void {
  active = source
  for (const [kind, fn] of Object.entries(stops) as [string, StopFn][]) {
    if (kind !== source) fn()
  }
  // Notify after the losers were stopped so subscribers see the settled state.
  sourceListeners.forEach((fn) => fn())
}

/** Most-recently-acquired source; MediaBarSlot uses it to pick the one visible bar.
 *  Sticky like hasActiveMedia (never reset to null) - bar visibility must derive from
 *  the playback contexts' content, this only breaks ties. */
export function getActiveSource(): MediaSource | null {
  return active
}

/** Subscribe to active-source changes (useSyncExternalStore-compatible). */
export function subscribeActiveSource(fn: () => void): () => void {
  sourceListeners.add(fn)
  return () => { sourceListeners.delete(fn) }
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
  else if (action === 'volume_up') t.volumeUp?.()
  else if (action === 'volume_down') t.volumeDown?.()
  else if (action === 'mute' || action === 'unmute' || action === 'toggle_mute') t.toggleMute?.()
}

/** Whether an engine is currently active and can take a remote volume command. */
export function hasLocalVolumeControl(): boolean {
  const t = active ? transports[active] : null
  return !!(t && (t.volumeUp || t.toggleMute))
}

// Winner selection shared by every "one media surface at a time" placement
// (MediaBarSlot's app bar, the desktop HUD island's now-playing slot). The
// most-recently-acquired source wins while still present; otherwise fall back
// in fixed presence order. Callers build the `present` map themselves (that is
// where surface-specific rules like route redundancy guards live).
export const MEDIA_FALLBACK_ORDER: readonly MediaSource[] = ['podcast', 'youtube', 'radio', 'liveRadio']

export function pickMediaWinner(
  present: Partial<Record<MediaSource, boolean>>,
  activeSource: MediaSource | null,
): MediaSource | null {
  if (activeSource && activeSource !== 'studio' && present[activeSource]) return activeSource
  return MEDIA_FALLBACK_ORDER.find((s) => present[s]) ?? null
}
