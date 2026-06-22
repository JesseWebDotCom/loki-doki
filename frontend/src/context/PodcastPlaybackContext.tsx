import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface PodcastChapter { title: string; startSec: number }
export interface TranscriptTurn { speaker: string; text: string }

export interface PodcastTrack {
  episodeId: string
  showId?: string
  showName: string
  title: string
  durationSec?: number
  chapters?: PodcastChapter[]
  coverUrl?: string
  description?: string
  transcript?: TranscriptTurn[]
}

interface PodcastPlaybackCtx {
  track: PodcastTrack | null
  playing: boolean
  positionSec: number
  duration: number
  rate: number
  autoplay: boolean
  queue: PodcastTrack[]
  queueIndex: number
  audioRef: React.RefObject<HTMLAudioElement | null>
  /** Play a single track now (replaces the queue with just this track). */
  play: (track: PodcastTrack, startSec?: number) => void
  /** Play a list as a queue starting at `index`. */
  playQueue: (tracks: PodcastTrack[], index?: number, startSec?: number) => void
  /** Append a track to Up Next. */
  enqueue: (track: PodcastTrack) => void
  removeFromQueue: (episodeId: string) => void
  next: () => void
  prev: () => void
  pause: () => void
  resume: () => void
  toggle: () => void
  seek: (sec: number) => void
  setRate: (r: number) => void
  setAutoplay: (v: boolean) => void
  close: () => void
  /** Clear the player (or just prune the queue) when a show is deleted, so a stale Now
   *  Playing banner doesn't linger for a show that no longer exists. */
  closeIfShow: (showId: string) => void
}

const Ctx = createContext<PodcastPlaybackCtx | null>(null)

async function saveWatchState(episodeId: string, positionSec: number, completed: boolean) {
  try {
    await fetch('/api/podcasts/watch-state', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ episodeId, positionSec: Math.floor(positionSec), completed }),
    })
  } catch { /* best-effort */ }
}

export function PodcastPlaybackProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [track, setTrack] = useState<PodcastTrack | null>(null)
  const [playing, setPlaying] = useState(false)
  const [positionSec, setPositionSec] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRateState] = useState(1)
  const [autoplay, setAutoplay] = useState(true)
  const [queue, setQueue] = useState<PodcastTrack[]>([])
  const [queueIndex, setQueueIndex] = useState(0)

  const pendingStart = useRef(0)
  const lastSaved = useRef(0)

  // ── Core transport ───────────────────────────────────────────────────────────
  const playTrackAt = useCallback((newTrack: PodcastTrack, startSec: number) => {
    pendingStart.current = startSec
    setTrack(newTrack)
    setPositionSec(startSec)
    setDuration(newTrack.durationSec ?? 0)
    setPlaying(true)
  }, [])

  const play = useCallback((newTrack: PodcastTrack, startSec = 0) => {
    setQueue([newTrack])
    setQueueIndex(0)
    playTrackAt(newTrack, startSec)
  }, [playTrackAt])

  const playQueue = useCallback((tracks: PodcastTrack[], index = 0, startSec = 0) => {
    if (tracks.length === 0) return
    const i = Math.max(0, Math.min(index, tracks.length - 1))
    setQueue(tracks)
    setQueueIndex(i)
    playTrackAt(tracks[i], startSec)
  }, [playTrackAt])

  const enqueue = useCallback((t: PodcastTrack) => {
    setQueue(prev => prev.some(q => q.episodeId === t.episodeId) ? prev : [...prev, t])
  }, [])

  const removeFromQueue = useCallback((episodeId: string) => {
    setQueue(prev => prev.filter(q => q.episodeId !== episodeId))
  }, [])

  const next = useCallback(() => {
    setQueueIndex(i => {
      const ni = i + 1
      if (ni < queue.length) { playTrackAt(queue[ni], 0); return ni }
      return i
    })
  }, [queue, playTrackAt])

  const prev = useCallback(() => {
    const el = audioRef.current
    if (el && el.currentTime > 3) { el.currentTime = 0; return }
    setQueueIndex(i => {
      const pi = i - 1
      if (pi >= 0) { playTrackAt(queue[pi], 0); return pi }
      if (el) el.currentTime = 0
      return i
    })
  }, [queue, playTrackAt])

  const pause = useCallback(() => { audioRef.current?.pause(); setPlaying(false) }, [])
  const resume = useCallback(() => { audioRef.current?.play().catch(() => {}); setPlaying(true) }, [])
  const toggle = useCallback(() => { setPlaying(p => !p) }, [])

  const seek = useCallback((sec: number) => {
    if (audioRef.current) audioRef.current.currentTime = sec
    setPositionSec(sec)
  }, [])

  const setRate = useCallback((r: number) => {
    setRateState(r)
    if (audioRef.current) audioRef.current.playbackRate = r
  }, [])

  const close = useCallback(() => {
    const el = audioRef.current
    if (el && track) void saveWatchState(track.episodeId, el.currentTime, false)
    el?.pause()
    setTrack(null); setPlaying(false); setPositionSec(0); setQueue([]); setQueueIndex(0)
  }, [track])

  const closeIfShow = useCallback((showId: string) => {
    if (!showId) return
    // Loaded track belongs to the deleted show → tear the player down entirely.
    if (track?.showId === showId) { close(); return }
    // Otherwise just drop any of its episodes still sitting in Up Next.
    setQueue(prev => prev.filter(q => q.showId !== showId))
  }, [track, close])

  // ── Drive the <audio> element when the track or play-state changes ────────────
  useEffect(() => {
    const el = audioRef.current
    if (!el || !track) return
    const expectedSrc = `/api/podcasts/episodes/${track.episodeId}/stream`
    if (!el.src.endsWith(expectedSrc)) {
      el.src = expectedSrc
      el.currentTime = pendingStart.current
      el.playbackRate = rate
    }
    if (playing) el.play().catch(() => {})
    else el.pause()
  }, [track?.episodeId, playing]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Audio element event wiring ───────────────────────────────────────────────
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onTime = () => {
      setPositionSec(el.currentTime)
      if (track && el.currentTime - lastSaved.current >= 10) {
        lastSaved.current = el.currentTime
        void saveWatchState(track.episodeId, el.currentTime, false)
      }
    }
    const onMeta = () => setDuration(el.duration || 0)
    const onEnded = () => {
      if (track) void saveWatchState(track.episodeId, 0, true)
      if (autoplay && queueIndex + 1 < queue.length) next()
      else setPlaying(false)
    }
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('durationchange', onMeta)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('ended', onEnded)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('durationchange', onMeta)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('ended', onEnded)
    }
  }, [track?.episodeId, autoplay, queue, queueIndex, next]) // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo<PodcastPlaybackCtx>(() => ({
    track, playing, positionSec, duration, rate, autoplay, queue, queueIndex, audioRef,
    play, playQueue, enqueue, removeFromQueue, next, prev, pause, resume, toggle, seek, setRate, setAutoplay, close, closeIfShow,
  }), [track, playing, positionSec, duration, rate, autoplay, queue, queueIndex,
       play, playQueue, enqueue, removeFromQueue, next, prev, pause, resume, toggle, seek, setRate, setAutoplay, close, closeIfShow])

  return (
    <Ctx.Provider value={value}>
      {children}
      <audio ref={audioRef} hidden preload="metadata" />
    </Ctx.Provider>
  )
}

export function usePodcastPlayback() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePodcastPlayback must be inside PodcastPlaybackProvider')
  return ctx
}
