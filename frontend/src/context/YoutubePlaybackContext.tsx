import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { acquireAudio, registerMediaStop } from '@/lib/mediaCoordinator'
import { uuid } from '@/lib/uuid'

/** A video handed off to the docked mini-player when you navigate away mid-watch. */
export interface YtMiniTrack {
  videoId: string
  title: string
  author: string | null
  channelThumb?: string | null
  localKind?: 'audio' | 'video'
  /** Non-YouTube source (tiktok/vimeo/reddit/link). When set, the mini-player plays a real
   *  <video> from `streamVideoUrl` and skips all YouTube-only watch-state/proxy plumbing. */
  source?: string
  /** Real-video URL for a hub track (e.g. /api/vstream/<source>/<id>) — makes the mini-player
   *  a controllable <video> for sources that normally play through a cross-origin embed. */
  streamVideoUrl?: string
  /** Official embed URL (TikTok/Vimeo) — the mini-player plays it in an <iframe>, instantly,
   *  the same way the watch page does (no yt-dlp, no autoplay quirks). */
  embedUrl?: string
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
  /** Which app this play belongs to — must be set explicitly by Music-app callers (search
   *  results, "play music" chat results, AI radio video mode) so their watch-state writes
   *  land under origin='music' and never pollute the Videos hub's watch history/Continue
   *  watching. Defaults to 'youtube' server-side when omitted. */
  origin?: 'youtube' | 'music'
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
  /** Id of the current play session (see PodcastPlaybackContext for the full rationale) —
   *  read by YoutubeMiniBar when reporting/clearing now-playing state. A ref, not state:
   *  it's read at report-time, not rendered, so it doesn't need to trigger re-renders. */
  sessionId: RefObject<string>
}

const Ctx = createContext<YoutubePlaybackCtx | null>(null)

export function YoutubePlaybackProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<YtMiniTrack[]>([])
  const [index, setIndex] = useState(0)
  const [startSec, setStartSec] = useState(0)
  const [positionSec, setPositionSec] = useState(0)
  const [expandRequest, setExpandRequest] = useState(0)
  // Id for the current play session — freshly minted whenever the docked video changes
  // (dock/playExpanded/next/prev), sent with now-playing reports and the stop/clear signal.
  // See nowPlaying.ts for why: it's what lets the device re-show a dismissed bar on a fresh
  // play and keeps a lagging clear from wiping out a session that's since moved on.
  const sessionIdRef = useRef('')

  const next = useCallback(() => {
    setIndex(i => {
      if (i + 1 >= queue.length) return i
      sessionIdRef.current = uuid()
      setStartSec(0); setPositionSec(0)
      return i + 1
    })
  }, [queue.length])

  const prev = useCallback(() => {
    setIndex(i => {
      if (i <= 0) return i
      sessionIdRef.current = uuid()
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
    sessionIdRef.current = uuid()
    setQueue(q)
    setIndex(Math.max(0, Math.min(i, q.length - 1)))
    setStartSec(start)
    setPositionSec(start)
  }, [])

  const playExpanded = useCallback((t: YtMiniTrack) => {
    acquireAudio('youtube')
    sessionIdRef.current = uuid()
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
    sessionId: sessionIdRef,
  }), [track, startSec, positionSec, index, queue.length, dock, playExpanded, expandRequest, next, prev, reportPosition, close, clearDock])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useYoutubePlayback() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useYoutubePlayback must be inside YoutubePlaybackProvider')
  return ctx
}
