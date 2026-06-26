import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { acquireAudio, registerMediaStop } from '@/lib/mediaCoordinator'

/** A video handed off to the docked mini-player when you navigate away mid-watch. */
export interface YtMiniTrack {
  videoId: string
  title: string
  author: string | null
  channelThumb?: string | null
  localKind?: 'audio' | 'video'
  /** Live audio stream URL (radio, etc.) — skips the YouTube IFrame entirely. */
  streamUrl?: string
  /** Thumbnail override for non-YouTube content (e.g. station favicon). */
  thumbnail?: string
  /** Emoji / text icon shown as fallback art when thumbnail is absent or fails (e.g. genre emoji for radio). */
  icon?: string
  durationSec?: number | null
  /** Route to expand back into (defaults to the YouTube watch page). Music video stations set this
   *  to their in-music Watch page so the docked video re-opens there, not in the YouTube app. */
  expandTo?: string
}

interface YoutubePlaybackCtx {
  /** The currently-docked video (queue[index]), or null when nothing is docked. */
  track: YtMiniTrack | null
  /** Where to start the current item (the spot you left off at; 0 after a skip). */
  startSec: number
  /** Last reported playback position — read by the watch page when you expand back. */
  positionSec: number
  hasNext: boolean
  hasPrev: boolean
  /** Hand a queue (current + up-next) to the mini-player, starting at `index`/`startSec`. */
  dock: (queue: YtMiniTrack[], index: number, startSec: number) => void
  /** Dock a single video and pop the mini-player open in its larger (expanded) form — used by
   *  the Shows/Movies trailer & theme thumbnails. */
  playExpanded: (track: YtMiniTrack) => void
  /** Bumped each time playExpanded is called, so the mini-player can react and expand. */
  expandRequest: number
  /** Advance / go back through the queue (auto-advance + the skip buttons). */
  next: () => void
  prev: () => void
  /** The mini-player reports its current position here as it plays. */
  reportPosition: (sec: number) => void
  /** Tear the mini-player down (the ✕ button, or end of queue). */
  close: () => void
  /** Clear the dock WITHOUT side effects — used when the watch page re-adopts the video. */
  clearDock: () => void
}

const Ctx = createContext<YoutubePlaybackCtx | null>(null)

export function YoutubePlaybackProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<YtMiniTrack[]>([])
  const [index, setIndex] = useState(0)
  const [startSec, setStartSec] = useState(0)
  const [positionSec, setPositionSec] = useState(0)
  const [expandRequest, setExpandRequest] = useState(0)

  const next = useCallback(() => {
    setIndex(i => {
      if (i + 1 >= queue.length) return i
      setStartSec(0); setPositionSec(0)
      return i + 1
    })
  }, [queue.length])

  const prev = useCallback(() => {
    setIndex(i => {
      if (i <= 0) return i
      setStartSec(0); setPositionSec(0)
      return i - 1
    })
  }, [])

  const reportPosition = useCallback((sec: number) => setPositionSec(sec), [])
  const close = useCallback(() => { setQueue([]); setIndex(0); setPositionSec(0) }, [])
  const clearDock = useCallback(() => { setQueue([]); setIndex(0) }, [])

  useEffect(() => registerMediaStop('youtube', close), [close])

  const dock = useCallback((q: YtMiniTrack[], i: number, start: number) => {
    acquireAudio('youtube')
    setQueue(q)
    setIndex(Math.max(0, Math.min(i, q.length - 1)))
    setStartSec(start)
    setPositionSec(start)
  }, [])

  const playExpanded = useCallback((t: YtMiniTrack) => {
    acquireAudio('youtube')
    setQueue([t])
    setIndex(0)
    setStartSec(0)
    setPositionSec(0)
    setExpandRequest((n) => n + 1)
  }, [])

  const track = queue[index] ?? null
  const value = useMemo<YoutubePlaybackCtx>(() => ({
    track, startSec, positionSec,
    hasNext: index + 1 < queue.length, hasPrev: index > 0,
    dock, playExpanded, expandRequest, next, prev, reportPosition, close, clearDock,
  }), [track, startSec, positionSec, index, queue.length, dock, playExpanded, expandRequest, next, prev, reportPosition, close, clearDock])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useYoutubePlayback() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useYoutubePlayback must be inside YoutubePlaybackProvider')
  return ctx
}
