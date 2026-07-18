// Shared Media Session integration - lock-screen / control-center / hardware-key
// metadata and transport for every player in the app.
//
// Each playback source calls setNowPlaying() when its track changes (and the state/
// position setters as it plays). One source is "current" at a time: the media
// coordinator's active source when it has metadata here, else the most recent caller.
// Action handlers are registered once and route to the current source's controls -
// explicitly provided ones first (players outside the coordinator: audiobooks, local
// music), else the coordinator transport (podcast/radio/youtube engines).
//
// This is what makes iOS lock-screen playback usable: without MediaMetadata + action
// handlers the system shows a blank player and, in a standalone PWA, is far more eager
// to suspend backgrounded audio.

import { dispatchTransport, getActiveSource, subscribeActiveSource, type MediaSource } from './mediaCoordinator'

export type NowPlayingSource = MediaSource | 'audiobook' | 'musicLocal' | 'videoHub'

export interface NowPlayingMeta {
  title: string
  artist?: string
  album?: string
  artworkUrl?: string
}

/** Optional direct controls for players that don't register a coordinator transport. */
export interface NowPlayingControls {
  toggle: () => void
  seekTo?: (sec: number) => void
  seekBy?: (deltaSec: number) => void
  next?: () => void
  prev?: () => void
  stop?: () => void
}

interface Entry {
  meta: NowPlayingMeta
  controls?: NowPlayingControls
  positionSec: number
  durationSec: number
  rate: number
  /** Ownership token: two surfaces can publish the same source (watch page and the
   *  docked mini-bar both speak for 'youtube'); a clear only lands if it comes from
   *  the surface that made the current entry. */
  key: symbol
}

const entries = new Map<NowPlayingSource, Entry>()
let lastSet: NowPlayingSource | null = null
let handlersReady = false

const ms = () => ('mediaSession' in navigator ? navigator.mediaSession : null)

function currentSource(): NowPlayingSource | null {
  const active = getActiveSource()
  if (active && entries.has(active)) return active
  return lastSet && entries.has(lastSet) ? lastSet : null
}

function currentEntry(): Entry | null {
  const src = currentSource()
  return src ? entries.get(src) ?? null : null
}

function applyMetadata(): void {
  const session = ms()
  if (!session) return
  const entry = currentEntry()
  if (!entry) {
    session.metadata = null
    session.playbackState = 'none'
    return
  }
  const { meta } = entry
  session.metadata = new MediaMetadata({
    title: meta.title,
    artist: meta.artist ?? '',
    album: meta.album ?? '',
    artwork: meta.artworkUrl ? [{ src: meta.artworkUrl, sizes: '512x512' }] : [],
  })
  ensureHandlers()
}

function act(fn: (entry: Entry, src: NowPlayingSource) => void): () => void {
  return () => {
    const src = currentSource()
    const entry = src ? entries.get(src) : null
    if (entry && src) fn(entry, src)
  }
}

function seekToSec(entry: Entry, sec: number): void {
  const clamped = Math.max(0, entry.durationSec > 0 ? Math.min(sec, entry.durationSec) : sec)
  if (entry.controls?.seekTo) entry.controls.seekTo(clamped)
  else dispatchTransport('seek', clamped)
}

function ensureHandlers(): void {
  const session = ms()
  if (!session || handlersReady) return
  handlersReady = true
  const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
    try { session.setActionHandler(action, handler) } catch { /* action unsupported here */ }
  }
  set('play', act((e) => (e.controls ? e.controls.toggle() : dispatchTransport('play'))))
  set('pause', act((e) => (e.controls ? e.controls.toggle() : dispatchTransport('pause'))))
  set('stop', act((e) => (e.controls?.stop ? e.controls.stop() : dispatchTransport('stop'))))
  set('previoustrack', act((e) => (e.controls?.prev ? e.controls.prev() : dispatchTransport('prev'))))
  set('nexttrack', act((e) => (e.controls?.next ? e.controls.next() : dispatchTransport('next'))))
  set('seekbackward', act((e) => {
    const off = 10
    if (e.controls?.seekBy) e.controls.seekBy(-off)
    else seekToSec(e, e.positionSec - off)
  }))
  set('seekforward', act((e) => {
    const off = 10
    if (e.controls?.seekBy) e.controls.seekBy(off)
    else seekToSec(e, e.positionSec + off)
  }))
  set('seekto', ((details: MediaSessionActionDetails) => {
    const entry = currentEntry()
    if (entry && typeof details.seekTime === 'number') seekToSec(entry, details.seekTime)
  }) as MediaSessionActionHandler)
}

/** Publish/refresh a source's lock-screen card. Call whenever the track changes.
 *  Returns an ownership token - pass it to clearNowPlaying so a stale surface can't
 *  wipe a newer publisher of the same source. */
export function setNowPlaying(source: NowPlayingSource, meta: NowPlayingMeta, controls?: NowPlayingControls): symbol {
  const prev = entries.get(source)
  const key = Symbol(source)
  entries.set(source, { meta, controls, positionSec: prev?.positionSec ?? 0, durationSec: prev?.durationSec ?? 0, rate: prev?.rate ?? 1, key })
  lastSet = source
  applyMetadata()
  return key
}

/** Remove a source's card (playback ended/cleared - NOT mere pause). With a token, only
 *  clears when that token still owns the entry. */
export function clearNowPlaying(source: NowPlayingSource, key?: symbol): void {
  const entry = entries.get(source)
  if (!entry) return
  if (key && entry.key !== key) return
  entries.delete(source)
  if (lastSet === source) lastSet = null
  applyMetadata()
}

export function setNowPlayingState(source: NowPlayingSource, state: 'playing' | 'paused'): void {
  const session = ms()
  if (!session || !entries.has(source)) return
  if (currentSource() === source) session.playbackState = state
}

/** Keep the lock-screen scrubber honest. Throttle upstream (once per timeupdate is fine). */
export function setNowPlayingPosition(source: NowPlayingSource, positionSec: number, durationSec: number, rate = 1): void {
  const entry = entries.get(source)
  if (!entry) return
  entry.positionSec = positionSec
  entry.durationSec = durationSec
  entry.rate = rate
  const session = ms()
  if (!session || currentSource() !== source || !('setPositionState' in session)) return
  if (!(Number.isFinite(durationSec) && durationSec > 0)) return
  try {
    session.setPositionState({ duration: durationSec, position: Math.min(Math.max(0, positionSec), durationSec), playbackRate: rate > 0 ? rate : 1 })
  } catch { /* invalid transient state during seeks - ignore */ }
}

// Re-point the card when the coordinator switches engines (e.g. podcast → radio).
if (typeof navigator !== 'undefined') subscribeActiveSource(applyMetadata)
