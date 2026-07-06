import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { RadioEngine, initialRadioState, type RadioState, type QueuedTrack } from '@/lib/music/radioEngine'
import type { DjStation } from '@/lib/music/radioStations'
import { recordHistory } from '@/lib/music/catalogApi'
import { acquireAudio, registerMediaStop, registerTransport } from '@/lib/mediaCoordinator'

/** Persistent AI Radio engine — lives above the router so a station keeps playing
 *  (and stays controllable from the mini-player) as you move around the app. */
interface RadioCtx extends RadioState {
  start: (s: DjStation, opts?: { silentIntro?: boolean }) => void
  playTrack: (t: { videoId: string; title: string; author?: string | null; thumbnail?: string }, resumeSec?: number) => void
  playPlaylist: (tracks: QueuedTrack[], startIndex?: number, opts?: { name?: string; playlistId?: string }) => void
  stop: () => void
  skip: () => void
  seek: (sec: number) => void
  getAnalyser: () => AnalyserNode | null
  togglePause: () => void
  setVolume: (v: number) => void
  toggleMute: () => void
  setSleep: (minutes: number | null) => void
  setDjMode: (mode: 'full' | 'minimal' | 'silent') => void
  /** Whether the audio-reactive EQ visualizer is shown (user preference, persisted). */
  visualizerEnabled: boolean
  toggleVisualizer: () => void
}

const Ctx = createContext<RadioCtx | null>(null)

export function RadioProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RadioState>(initialRadioState)
  // EQ visualizer on/off — a lightweight UI preference, stored per-device in localStorage
  // (same approach as music.djMode). Defaults to on.
  const [visualizerEnabled, setVisualizerEnabled] = useState(
    () => (typeof localStorage !== 'undefined' ? localStorage.getItem('music.visualizerEnabled') !== '0' : true),
  )
  const toggleVisualizer = () => setVisualizerEnabled(v => {
    const next = !v
    try { localStorage.setItem('music.visualizerEnabled', next ? '1' : '0') } catch { /* quota */ }
    return next
  })
  const engineRef = useRef<RadioEngine | null>(null)
  // Lazily (re)create: StrictMode's cleanup destroys the engine, but destroy() is
  // revivable — the next start() rebuilds the audio graph — so we keep the instance.
  if (!engineRef.current) engineRef.current = new RadioEngine(setState)

  useEffect(() => {
    const unregister = registerMediaStop('radio', () => engineRef.current?.stop())
    const e = engineRef.current
    const unTransport = registerTransport('radio', {
      toggle: () => e?.togglePause(), next: () => e?.skip(),
      prev: () => e?.seek(0), seek: (sec) => e?.seek(sec), stop: () => e?.stop(),
    })
    return () => { unregister(); unTransport(); engineRef.current?.destroy() }
  }, [])

  // Log each newly-playing song to history (powers Continue Listening + recently played).
  const lastLogged = useRef<string | null>(null)
  useEffect(() => {
    const t = state.currentTrack
    if (t && t.videoId !== lastLogged.current) {
      lastLogged.current = t.videoId
      void recordHistory({ videoId: t.videoId, title: t.title, artist: t.author ?? undefined, stationId: state.station?.id }).catch(() => {})
    }
  }, [state.currentTrack, state.station])

  // Id for the current play session (see PodcastPlaybackContext for the full rationale) —
  // freshly minted whenever radio goes active→playing for a NEW station/track combo, i.e.
  // starting a station, a song changing within it, or resuming after a stop. Radio doesn't
  // have an explicit "play" call site like podcast/YouTube (the engine drives track changes
  // internally), so this is derived reactively instead of minted at a call site.
  const sessionIdRef = useRef('')
  const wasActiveRef = useRef(false)
  const lastKeyRef = useRef('')
  useEffect(() => {
    const key = `${state.station?.id ?? ''}|${state.currentTrack?.videoId ?? ''}`
    const justActivated = state.active && !wasActiveRef.current
    const keyChanged = state.active && key !== lastKeyRef.current
    if (justActivated || keyChanged) sessionIdRef.current = crypto.randomUUID()
    wasActiveRef.current = state.active
    lastKeyRef.current = key
  }, [state.active, state.station?.id, state.currentTrack?.videoId])

  // Report now-playing to the server so the controller surface + screen devices reflect the
  // active station, play/pause, and progress. Fires immediately on track/pause/station
  // changes and every ~5 s while playing (the positionSec bucket) to advance the progress.
  useEffect(() => {
    // Only the tab that actually has a track reports, so idle/background tabs don't clobber
    // the shared now-playing snapshot the controller reads.
    if (!state.currentTrack && !state.active) return
    void fetch('/api/pod/now-playing', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'radio',
        sessionId: sessionIdRef.current,
        stationId: state.station?.id ?? null,
        videoId: state.currentTrack?.videoId ?? null,
        title: state.currentTrack?.title ?? '',
        artist: state.currentTrack?.author ?? null,
        cover: state.currentTrack?.thumbnail ?? (state.currentTrack?.videoId ? `https://i.ytimg.com/vi/${state.currentTrack.videoId}/mqdefault.jpg` : ''),
        positionSec: Math.round(state.positionSec),
        durationSec: Math.round(state.durationSec),
        playing: state.active && !state.paused,
      }),
    }).catch(() => {})
  }, [state.currentTrack, state.paused, state.station, state.active, Math.floor(state.positionSec / 5)])

  // Tell the device to drop/hide its media bar when THIS tab's radio stops — otherwise the
  // last reported snapshot just sits there until its 5-minute staleness timeout. Only fires on
  // a true was-active→inactive transition (never on initial mount), so a fresh tab loading
  // inactive doesn't wipe out a station another tab is legitimately still playing.
  const wasActive = useRef(false)
  useEffect(() => {
    if (state.active) { wasActive.current = true; return }
    if (!wasActive.current) return
    wasActive.current = false
    void fetch('/api/pod/now-playing/clear', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'radio', sessionId: sessionIdRef.current }),
    }).catch(() => {})
  }, [state.active])

  const e = engineRef.current
  const value = useMemo<RadioCtx>(() => ({
    ...state,
    start: (s, opts) => { acquireAudio('radio'); e.start(s, opts) },
    playTrack: (t, resumeSec) => { acquireAudio('radio'); e.playTrack(t, resumeSec) },
    playPlaylist: (t, i, o) => { acquireAudio('radio'); e.playPlaylist(t, i, o) },
    stop: () => e.stop(),
    skip: () => e.skip(),
    seek: (sec) => e.seek(sec),
    getAnalyser: () => e.getAnalyser(),
    togglePause: () => e.togglePause(),
    setVolume: (v) => e.setVolume(v),
    toggleMute: () => e.toggleMute(),
    setSleep: (m) => e.setSleep(m),
    setDjMode: (m) => e.setDjMode(m),
    visualizerEnabled,
    toggleVisualizer,
  }), [state, e, visualizerEnabled])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRadio() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useRadio must be inside RadioProvider')
  return ctx
}
