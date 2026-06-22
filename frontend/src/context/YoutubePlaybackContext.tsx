import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** A video handed off to the docked mini-player when you navigate away mid-watch. */
export interface YtMiniTrack {
  videoId: string
  title: string
  author: string | null
  localKind?: 'audio' | 'video'
  durationSec?: number | null
}

interface YoutubePlaybackCtx {
  track: YtMiniTrack | null
  /** Where to start the mini-player (the spot you left off at). */
  startSec: number
  /** Last reported playback position — read by the watch page when you expand back. */
  positionSec: number
  /** Hand a video to the mini-player (called by the watch page on navigate-away). */
  dock: (track: YtMiniTrack, startSec: number) => void
  /** The mini-player reports its current position here as it plays. */
  reportPosition: (sec: number) => void
  /** Tear the mini-player down (the ✕ button). */
  close: () => void
  /** Clear the dock WITHOUT side effects — used when the watch page re-adopts the video. */
  clearDock: () => void
}

const Ctx = createContext<YoutubePlaybackCtx | null>(null)

export function YoutubePlaybackProvider({ children }: { children: ReactNode }) {
  const [track, setTrack] = useState<YtMiniTrack | null>(null)
  const [startSec, setStartSec] = useState(0)
  const [positionSec, setPositionSec] = useState(0)

  const dock = useCallback((t: YtMiniTrack, start: number) => {
    setTrack(t)
    setStartSec(start)
    setPositionSec(start)
  }, [])

  const reportPosition = useCallback((sec: number) => setPositionSec(sec), [])
  const close = useCallback(() => { setTrack(null); setPositionSec(0) }, [])
  const clearDock = useCallback(() => { setTrack(null) }, [])

  const value = useMemo<YoutubePlaybackCtx>(() => ({
    track, startSec, positionSec,
    dock, reportPosition, close, clearDock,
  }), [track, startSec, positionSec, dock, reportPosition, close, clearDock])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useYoutubePlayback() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useYoutubePlayback must be inside YoutubePlaybackProvider')
  return ctx
}
