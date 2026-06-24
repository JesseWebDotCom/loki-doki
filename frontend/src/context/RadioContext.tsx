import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { RadioEngine, initialRadioState, type RadioState } from '@/lib/music/radioEngine'
import type { DjStation } from '@/lib/music/radioStations'

/** Persistent AI Radio engine — lives above the router so a station keeps playing
 *  (and stays controllable from the mini-player) as you move around the app. */
interface RadioCtx extends RadioState {
  start: (s: DjStation) => void
  stop: () => void
  skip: () => void
  togglePause: () => void
  setVolume: (v: number) => void
  toggleMute: () => void
}

const Ctx = createContext<RadioCtx | null>(null)

export function RadioProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RadioState>(initialRadioState)
  const engineRef = useRef<RadioEngine | null>(null)
  // Lazily (re)create: StrictMode's cleanup destroys the engine, but destroy() is
  // revivable — the next start() rebuilds the audio graph — so we keep the instance.
  if (!engineRef.current) engineRef.current = new RadioEngine(setState)

  useEffect(() => {
    return () => { engineRef.current?.destroy() }
  }, [])

  const e = engineRef.current
  const value = useMemo<RadioCtx>(() => ({
    ...state,
    start: (s) => e.start(s),
    stop: () => e.stop(),
    skip: () => e.skip(),
    togglePause: () => e.togglePause(),
    setVolume: (v) => e.setVolume(v),
    toggleMute: () => e.toggleMute(),
  }), [state, e])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useRadio() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useRadio must be inside RadioProvider')
  return ctx
}
