import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { RadioEngine, initialRadioState, type RadioState } from '@/lib/music/radioEngine'
import type { DjStation } from '@/lib/music/radioStations'
import { recordHistory } from '@/lib/music/catalogApi'
import { acquireAudio, registerMediaStop, registerTransport } from '@/lib/mediaCoordinator'

/** Persistent AI Radio engine — lives above the router so a station keeps playing
 *  (and stays controllable from the mini-player) as you move around the app. */
interface RadioCtx extends RadioState {
  start: (s: DjStation, opts?: { silentIntro?: boolean }) => void
  playTrack: (t: { videoId: string; title: string; author?: string | null; thumbnail?: string }, resumeSec?: number) => void
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

  const e = engineRef.current
  const value = useMemo<RadioCtx>(() => ({
    ...state,
    start: (s, opts) => { acquireAudio('radio'); e.start(s, opts) },
    playTrack: (t, resumeSec) => { acquireAudio('radio'); e.playTrack(t, resumeSec) },
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
