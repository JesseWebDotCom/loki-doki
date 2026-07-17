import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { RadioEngine, initialRadioState, type RadioState, type QueuedTrack, type ShuffleMode } from '@/lib/music/radioEngine'
import type { DjStation } from '@/lib/music/radioStations'
import { recordHistory, reportHistoryProgress } from '@/lib/music/catalogApi'
import { acquireAudio, registerMediaStop, registerTransport } from '@/lib/mediaCoordinator'
import { registerDuckable } from '@/lib/speechDucking'
import { loadDsp, saveDsp, type DspSettings } from '@/lib/music/dsp'
import { uuid } from '@/lib/uuid'

/** Persistent AI Radio engine — lives above the router so a station keeps playing
 *  (and stays controllable from the mini-player) as you move around the app. */
interface RadioCtx extends RadioState {
  start: (s: DjStation, opts?: { silentIntro?: boolean }) => void
  playTrack: (t: { videoId: string; title: string; author?: string | null; thumbnail?: string }, resumeSec?: number) => void
  playPlaylist: (tracks: QueuedTrack[], startIndex?: number, opts?: { name?: string; playlistId?: string }) => void
  stop: () => void
  skip: () => void
  seek: (sec: number) => void
  /** Jump by ±seconds (skip a podcast ad, rewind a chorus). */
  seekBy: (delta: number) => void
  /** Repeat the current track (from RadioState.repeatOne). */
  setRepeatOne: (on: boolean) => void
  getAnalyser: () => AnalyserNode | null
  togglePause: () => void
  setVolume: (v: number) => void
  toggleMute: () => void
  setSleep: (minutes: number | null) => void
  setDjMode: (mode: 'full' | 'minimal' | 'silent') => void
  /** Whether the audio-reactive EQ visualizer is shown (user preference, persisted). */
  visualizerEnabled: boolean
  toggleVisualizer: () => void
  /** DSP: EQ / crossfeed / loudness settings (persisted per device) + crossfade length. */
  dsp: DspSettings
  setDsp: (next: DspSettings) => void
  crossfadeMs: number
  setCrossfadeMs: (ms: number) => void
  /** Sweet Fades: overlap the next song where this one's outro begins (loudness-timed). */
  sweetFades: boolean
  setSweetFades: (on: boolean) => void
  /** AutoMix: beat-matched transitions (tempo nudge during the crossfade when BPMs are close). */
  autoMix: boolean
  setAutoMix: (on: boolean) => void
  /** Shuffle mode: off / true random / no repeats until everything has played. */
  shuffleMode: ShuffleMode
  setShuffleMode: (mode: ShuffleMode) => void
  /** Up Next editing: move a queue item (absolute indexes) / play a queue item now. */
  reorderQueue: (from: number, to: number) => void
  jumpTo: (index: number) => void
  /** How many seconds a lyric line highlights BEFORE it's sung (read-ahead). Per-device pref. */
  lyricLeadSec: number
  setLyricLeadSec: (sec: number) => void
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
  // DSP settings (EQ/crossfeed/loudness) - loaded once, saved + applied on change.
  const [dsp, setDspState] = useState<DspSettings>(loadDsp)
  const setDsp = (next: DspSettings) => { setDspState(next); saveDsp(next) }
  // Mirrors the engine's persisted value (same localStorage key) for the settings UI.
  const [crossfadeMs, setCrossfadeState] = useState(() => {
    try {
      const raw = localStorage.getItem('music.crossfadeMs')
      if (raw == null) return 1300
      const v = Number(raw)
      return Number.isFinite(v) && v >= 0 ? Math.min(v, 12000) : 1300
    } catch { return 1300 }
  })
  // Lyric read-ahead: how early (seconds) a line highlights before it's sung. Per-device, like
  // the visualizer/crossfade prefs. Default 1.0 (see DEFAULT_LYRIC_LEAD_SEC in nowPlayingParts).
  const [lyricLeadSec, setLyricLeadState] = useState(() => {
    try {
      const raw = localStorage.getItem('music.lyricLeadSec')
      if (raw == null) return 0
      const v = Number(raw)
      return Number.isFinite(v) && v >= 0 ? Math.min(v, 3) : 0
    } catch { return 0 }
  })
  const setLyricLeadSec = (sec: number) => {
    const v = Math.max(0, Math.min(3, sec))
    setLyricLeadState(v)
    try { localStorage.setItem('music.lyricLeadSec', String(v)) } catch { /* quota */ }
  }

  const engineRef = useRef<RadioEngine | null>(null)
  // Lazily (re)create: StrictMode's cleanup destroys the engine, but destroy() is
  // revivable — the next start() rebuilds the audio graph — so we keep the instance.
  if (!engineRef.current) engineRef.current = new RadioEngine(setState)
  const setCrossfadeMs = (ms: number) => {
    engineRef.current?.setCrossfadeMs(ms)
    setCrossfadeState(engineRef.current?.getCrossfadeMs() ?? ms)
  }
  // Mirrors the engine's persisted Sweet Fades flag (same localStorage key) for the UI.
  const [sweetFades, setSweetFadesState] = useState(() => engineRef.current?.getSweetFades() ?? true)
  const setSweetFades = (on: boolean) => {
    engineRef.current?.setSweetFades(on)
    setSweetFadesState(engineRef.current?.getSweetFades() ?? on)
  }
  // AutoMix (beat-matched transitions) mirrors the engine's persisted flag the same way.
  const [autoMix, setAutoMixState] = useState(() => engineRef.current?.getAutoMix() ?? false)
  const setAutoMix = (on: boolean) => {
    engineRef.current?.setAutoMix(on)
    setAutoMixState(engineRef.current?.getAutoMix() ?? on)
  }
  // Shuffle mode mirrors the engine's persisted value for the mode picker.
  const [shuffleMode, setShuffleModeState] = useState<ShuffleMode>(() => engineRef.current?.getShuffleMode() ?? 'off')
  const setShuffleMode = (mode: ShuffleMode) => {
    engineRef.current?.setShuffleMode(mode)
    setShuffleModeState(engineRef.current?.getShuffleMode() ?? mode)
  }

  useEffect(() => {
    const unregister = registerMediaStop('radio', () => engineRef.current?.stop())
    const e = engineRef.current
    const unTransport = registerTransport('radio', {
      toggle: () => e?.togglePause(), next: () => e?.skip(),
      prev: () => e?.seek(0), seek: (sec) => e?.seek(sec), stop: () => e?.stop(),
    })
    // Duck the station under companion speech on this device (lib/speechDucking.ts).
    const unDuck = registerDuckable('radio', {
      duck: () => engineRef.current?.duckForSpeech(),
      restore: () => engineRef.current?.unduckAfterSpeech(),
    })
    return () => { unregister(); unTransport(); unDuck(); engineRef.current?.destroy() }
  }, [])

  // Log each newly-playing song to history (powers Continue Listening + recently played).
  // The row id comes back so the progress beacon can report how far the listener actually
  // got - fired when the track changes and on page unload (real minutes for stats/Replay).
  const lastLogged = useRef<string | null>(null)
  const historyRow = useRef<{ id: string; pos: number; dur: number } | null>(null)
  useEffect(() => {
    const row = historyRow.current
    if (row && state.positionSec > 0) { row.pos = state.positionSec; row.dur = state.durationSec }
  }, [state.positionSec, state.durationSec])
  useEffect(() => {
    const t = state.currentTrack
    if (t && t.videoId !== lastLogged.current) {
      lastLogged.current = t.videoId
      const prev = historyRow.current
      if (prev && prev.pos > 0) reportHistoryProgress(prev.id, prev.pos, prev.dur || undefined)
      historyRow.current = null
      void recordHistory({ videoId: t.videoId, title: t.title, artist: t.author ?? undefined, stationId: state.station?.id })
        .then(r => { if (r?.id) historyRow.current = { id: r.id, pos: 0, dur: 0 } })
        .catch(() => {})
    }
  }, [state.currentTrack, state.station])
  useEffect(() => {
    const flush = () => {
      const row = historyRow.current
      if (row && row.pos > 0) reportHistoryProgress(row.id, row.pos, row.dur || undefined)
    }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

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
    if (justActivated || keyChanged) sessionIdRef.current = uuid()
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
    seekBy: (delta) => e.seekBy(delta),
    reorderQueue: (from, to) => e.reorderQueue(from, to),
    jumpTo: (i) => e.jumpTo(i),
    setRepeatOne: (on) => e.setRepeatOne(on),
    getAnalyser: () => e.getAnalyser(),
    togglePause: () => e.togglePause(),
    setVolume: (v) => e.setVolume(v),
    toggleMute: () => e.toggleMute(),
    setSleep: (m) => e.setSleep(m),
    setDjMode: (m) => e.setDjMode(m),
    dsp,
    setDsp,
    crossfadeMs,
    setCrossfadeMs,
    sweetFades,
    setSweetFades,
    autoMix,
    setAutoMix,
    shuffleMode,
    setShuffleMode,
    lyricLeadSec,
    setLyricLeadSec,
    visualizerEnabled,
    toggleVisualizer,
  }), [state, e, visualizerEnabled, dsp, crossfadeMs, sweetFades, autoMix, shuffleMode, lyricLeadSec])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRadio() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useRadio must be inside RadioProvider')
  return ctx
}
