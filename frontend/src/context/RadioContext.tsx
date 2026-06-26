import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { RadioEngine, initialRadioState, type RadioState } from '@/lib/music/radioEngine'
import type { DjStation } from '@/lib/music/radioStations'
import { recordHistory } from '@/lib/music/catalogApi'

/** Persistent AI Radio engine — lives above the router so a station keeps playing
 *  (and stays controllable from the mini-player) as you move around the app. */
interface RadioCtx extends RadioState {
  start: (s: DjStation) => void
  playTrack: (t: { videoId: string; title: string; author?: string | null; thumbnail?: string }) => void
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
    return () => { engineRef.current?.destroy() }
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

  const e = engineRef.current
  const value = useMemo<RadioCtx>(() => ({
    ...state,
    start: (s) => e.start(s),
    playTrack: (t) => e.playTrack(t),
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
