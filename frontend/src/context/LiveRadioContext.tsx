import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { LiveRadioEngine, initialLiveRadioState, type LiveRadioState, type LiveStationRef, type LiveRecordingRef } from '@/lib/music/liveRadioEngine'
import { acquireAudio, registerMediaStop, registerTransport } from '@/lib/mediaCoordinator'
import { clearNowPlaying, setNowPlaying, setNowPlayingState } from '@/lib/mediaSession'
import { registerDuckable } from '@/lib/speechDucking'
import { uuid } from '@/lib/uuid'

/** Persistent live-internet-radio engine — lives above the router so a station keeps playing
 *  (and stays controllable from the mini-player) as you move around the app. Sibling of
 *  RadioContext; the mediaCoordinator keeps the two mutually exclusive. */
interface LiveRadioCtx extends LiveRadioState {
  playLive: (s: LiveStationRef & { preview?: boolean }) => void
  playRecording: (r: LiveRecordingRef) => void
  stop: () => void
  togglePause: () => void
  seek: (sec: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  getAnalyser: () => AnalyserNode | null
}

const Ctx = createContext<LiveRadioCtx | null>(null)

export function LiveRadioProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LiveRadioState>(initialLiveRadioState)
  const engineRef = useRef<LiveRadioEngine | null>(null)
  // Lazily (re)create: StrictMode's cleanup destroys the engine, but destroy() is
  // revivable — the next play rebuilds playback — so we keep the instance.
  if (!engineRef.current) engineRef.current = new LiveRadioEngine(setState)

  useEffect(() => {
    const unregister = registerMediaStop('liveRadio', () => engineRef.current?.stop())
    const e = engineRef.current
    const unTransport = registerTransport('liveRadio', {
      toggle: () => e?.togglePause(), next: () => {},
      prev: () => e?.seek(0), seek: (sec) => e?.seek(sec), stop: () => e?.stop(),
    })
    // Duck the stream under companion speech on this device (lib/speechDucking.ts).
    const unDuck = registerDuckable('liveRadio', {
      duck: () => engineRef.current?.duckForSpeech(),
      restore: () => engineRef.current?.unduckAfterSpeech(),
    })
    return () => { unregister(); unTransport(); unDuck(); engineRef.current?.destroy() }
  }, [])

  // Id for the current play session (see RadioContext for the full rationale) — freshly
  // minted whenever live radio goes inactive→active or switches station/recording.
  const sessionIdRef = useRef('')
  const wasActiveRef = useRef(false)
  const lastKeyRef = useRef('')
  useEffect(() => {
    const key = `${state.station?.id ?? ''}|${state.recording?.id ?? ''}`
    const justActivated = state.active && !wasActiveRef.current
    const keyChanged = state.active && key !== lastKeyRef.current
    if (justActivated || keyChanged) sessionIdRef.current = uuid()
    wasActiveRef.current = state.active
    lastKeyRef.current = key
  }, [state.active, state.station?.id, state.recording?.id])

  // Lock-screen / control-center card for live radio ('liveRadio' coordinator transport).
  useEffect(() => {
    if (!state.active) { clearNowPlaying('liveRadio'); return }
    const title = state.station?.name ?? state.recording?.title ?? 'Live Radio'
    setNowPlaying('liveRadio', {
      title,
      artist: state.recording?.stationName ?? (state.station ? 'Live Radio' : undefined),
      artworkUrl: state.station?.favicon || undefined,
    })
  }, [state.active, state.station, state.recording])
  useEffect(() => {
    if (state.active) setNowPlayingState('liveRadio', state.paused ? 'paused' : 'playing')
  }, [state.active, state.paused])

  // Report now-playing to the server so the controller surface + screen devices reflect the
  // active station. Reported as source 'radio' — the backend's NowPlayingSource union is
  // radio|youtube|podcast, and live radio IS radio to a device player bar; the sessionId
  // keeps it from clobbering (or being clobbered by) an AI-radio session.
  useEffect(() => {
    if (!state.active) return
    const title = state.station?.name ?? state.recording?.title ?? ''
    void fetch('/api/pod/now-playing', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'radio',
        sessionId: sessionIdRef.current,
        stationId: state.station?.id ?? null,
        videoId: null,
        title,
        artist: state.recording?.stationName ?? (state.station ? 'Live Radio' : null),
        cover: state.station?.favicon ?? '',
        positionSec: Math.round(state.positionSec),
        durationSec: Math.round(state.durationSec),
        playing: state.active && !state.paused,
      }),
    }).catch(() => {})
  }, [state.active, state.paused, state.station, state.recording, Math.floor(state.positionSec / 5)])

  // Tell the device to drop its media bar when THIS tab's live radio stops (see RadioContext).
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
  const value = useMemo<LiveRadioCtx>(() => ({
    ...state,
    playLive: (s) => { acquireAudio('liveRadio'); e.playLive(s) },
    playRecording: (r) => { acquireAudio('liveRadio'); e.playRecording(r) },
    stop: () => e.stop(),
    togglePause: () => e.togglePause(),
    seek: (sec) => e.seek(sec),
    setVolume: (v) => e.setVolume(v),
    toggleMute: () => e.toggleMute(),
    getAnalyser: () => e.getAnalyser(),
  }), [state, e])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useLiveRadio() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useLiveRadio must be inside LiveRadioProvider')
  return ctx
}
