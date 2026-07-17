import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { acquireAudio, registerMediaStop, registerTransport } from '@/lib/mediaCoordinator'
import { uuid } from '@/lib/uuid'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences } from '@/hooks/useUserPreferences'
import {
  addToQueue, clearQueue as clearQueueApi, getChapters, getQueue, getShowSettings,
  queueItemToTrack, removeQueueItem, reorderQueue as reorderQueueApi, replaceQueue,
  reportTimeSaved, DEFAULT_SHOW_SETTINGS,
  type ShowPlaybackSettings,
} from '@/lib/podcast/playerApi'
import {
  applyPodcastDsp, duckPodcastForSpeech, ensurePodcastGraph, fadePodcastVolume, resetPodcastVolume,
  setPodcastBaseRate, takeSavedSeconds, unduckPodcastAfterSpeech,
} from '@/lib/podcastAudioGraph'
import { registerDuckable } from '@/lib/speechDucking'

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

export type SleepMode = 'off' | 'timer' | 'episode' | 'chapter'
export interface SleepState { mode: SleepMode; minutes?: number; until?: number }

interface PodcastPlaybackCtx {
  track: PodcastTrack | null
  playing: boolean
  positionSec: number
  duration: number
  rate: number
  autoplay: boolean
  /** Server-persisted Up Next (upcoming episodes only; the current track is not in it). */
  queue: PodcastTrack[]
  /** Chapters for the current track (generated episodes carry them; RSS ones are fetched). */
  chapters: PodcastChapter[]
  /** This user's playback settings for the current show (defaults when none saved). */
  showSettings: ShowPlaybackSettings
  sleep: SleepState
  audioRef: React.RefObject<HTMLAudioElement | null>
  /** Play a single track now. Up Next is left intact and plays after it. */
  play: (track: PodcastTrack, startSec?: number) => void
  /** Play tracks[index] now; the rest continue implicitly AFTER queued episodes (the
   *  show-page "listen through" flow). Does not touch the persistent Up Next queue. */
  playQueue: (tracks: PodcastTrack[], index?: number, startSec?: number) => void
  /** Play tracks[0] now and REPLACE Up Next with the rest (filters "Play all"). */
  playAllIntoQueue: (tracks: PodcastTrack[]) => void
  /** Append to Up Next (server-persisted). */
  enqueue: (track: PodcastTrack) => void
  /** Put at the front of Up Next (server-persisted). */
  playNextInQueue: (track: PodcastTrack) => void
  /** Play a queued episode now; it and everything before it leave the queue. */
  playFromQueue: (episodeId: string) => void
  removeFromQueue: (episodeId: string) => void
  reorderQueue: (episodeIds: string[]) => void
  clearQueue: () => void
  next: () => void
  prev: () => void
  nextChapter: () => void
  prevChapter: () => void
  pause: () => void
  resume: () => void
  toggle: () => void
  seek: (sec: number) => void
  setRate: (r: number) => void
  setAutoplay: (v: boolean) => void
  setSleep: (mode: SleepMode, minutes?: number) => void
  /** Re-apply the current show's saved settings (call after saving them). */
  refreshShowSettings: (showId: string) => void
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

// Session cache so replaying a show doesn't refetch its settings on every episode.
const showSettingsCache = new Map<string, ShowPlaybackSettings>()

async function loadShowSettings(showId: string, force = false): Promise<ShowPlaybackSettings> {
  if (!force) {
    const hit = showSettingsCache.get(showId)
    if (hit) return hit
  }
  const settings = await getShowSettings(showId).catch(() => ({ ...DEFAULT_SHOW_SETTINGS }))
  showSettingsCache.set(showId, settings)
  return settings
}

const SLEEP_FADE_SEC = 15

export function PodcastPlaybackProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const { user } = useAuth()
  const [track, setTrack] = useState<PodcastTrack | null>(null)
  const [playing, setPlaying] = useState(false)
  const [positionSec, setPositionSec] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRateState] = useState(1)
  const [autoplay, setAutoplay] = useState(true)
  const [queue, setQueue] = useState<PodcastTrack[]>([])
  const [chapters, setChapters] = useState<PodcastChapter[]>([])
  const [showSettings, setShowSettings] = useState<ShowPlaybackSettings>({ ...DEFAULT_SHOW_SETTINGS })
  const [sleep, setSleepState] = useState<SleepState>({ mode: 'off' })

  const pendingStart = useRef(0)
  const lastSaved = useRef(0)
  const outroFired = useRef(false)
  const sleepFadeStarted = useRef(false)
  // Id for the current play session; freshly minted on every playTrackAt (play/playQueue/
  // next/prev alike), sent with now-playing reports and the stop/clear signal. See
  // nowPlaying.ts for why: it's what lets the device re-show a dismissed bar on a fresh
  // play and keeps a lagging clear from wiping out a session that's since moved on.
  const sessionIdRef = useRef('')

  // Refs mirrored for event handlers / intervals (avoid stale closures).
  const queueRef = useRef(queue); queueRef.current = queue
  const trackRef = useRef(track); trackRef.current = track
  const autoplayRef = useRef(autoplay); autoplayRef.current = autoplay
  const sleepRef = useRef(sleep); sleepRef.current = sleep
  const showSettingsRef = useRef(showSettings); showSettingsRef.current = showSettings
  const chaptersRef = useRef(chapters); chaptersRef.current = chapters
  const posRef = useRef(positionSec); posRef.current = positionSec
  const durRef = useRef(duration); durRef.current = duration

  // ── Global DSP prefs (per-user, synced across devices) ───────────────────────
  const { data: prefs } = useUserPreferences()
  const globalVoiceBoost = prefs?.['podcasts.voiceBoost'] === true
  const globalTrimSilence = prefs?.['podcasts.trimSilence'] === true
  useEffect(() => {
    applyPodcastDsp({
      voiceBoost: showSettings.voiceBoost ?? globalVoiceBoost,
      trimSilence: showSettings.trimSilence ?? globalTrimSilence,
    })
  }, [globalVoiceBoost, globalTrimSilence, showSettings.voiceBoost, showSettings.trimSilence])

  // ── Server queue sync ──────────────────────────────────────────────────────────
  const syncQueue = useCallback(async () => {
    try { setQueue((await getQueue()).map(queueItemToTrack)) } catch { /* offline - keep local */ }
  }, [])

  useEffect(() => {
    if (!user?.id) { setQueue([]); return }
    void syncQueue()
    // Cross-device: pick up queue edits made elsewhere when this tab regains focus.
    let last = Date.now()
    const onFocus = () => {
      if (Date.now() - last < 30_000) return
      last = Date.now()
      void syncQueue()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [user?.id, syncQueue])

  const applyQueueResult = useCallback((items: Awaited<ReturnType<typeof getQueue>>) => {
    setQueue(items.map(queueItemToTrack))
  }, [])

  // ── Core transport ───────────────────────────────────────────────────────────
  const playTrackAt = useCallback((newTrack: PodcastTrack, startSec: number) => {
    acquireAudio('podcast')   // stop radio/YouTube — podcasts are a first-class audio source
    sessionIdRef.current = uuid()
    // Reset the resume-save watermark. Otherwise it carries over from the previous episode, so
    // the `currentTime - lastSaved >= 10` gate never fires for a new episode until its playhead
    // passes the old episode's position — for most episodes, never — silently losing resume.
    lastSaved.current = 0
    outroFired.current = false
    pendingStart.current = startSec
    // Replaying the episode that's already loaded (e.g. tapping one of its bookmarks):
    // the src-driving effect won't reset currentTime, so seek the element directly.
    const el = audioRef.current
    if (el && el.src.endsWith(`/api/podcasts/episodes/${newTrack.episodeId}/stream`)) {
      el.currentTime = startSec
      el.play().catch(() => {})
    }
    setTrack(newTrack)
    setPositionSec(startSec)
    setDuration(newTrack.durationSec ?? 0)
    setPlaying(true)

    // Per-show playback settings: speed applied at episode start, intro auto-skipped
    // (only when starting before it - a saved resume position always wins).
    const showId = newTrack.showId
    setShowSettings({ ...DEFAULT_SHOW_SETTINGS })
    if (showId) {
      void loadShowSettings(showId).then(s => {
        if (trackRef.current?.episodeId !== newTrack.episodeId) return
        setShowSettings(s)
        if (s.speed != null) {
          setRateState(s.speed)
          setPodcastBaseRate(s.speed)
          if (audioRef.current) audioRef.current.playbackRate = s.speed
        }
        if (s.skipIntroSec > 0 && startSec < s.skipIntroSec) {
          pendingStart.current = s.skipIntroSec
          const el = audioRef.current
          if (el && el.currentTime < s.skipIntroSec) el.currentTime = s.skipIntroSec
          setPositionSec(s.skipIntroSec)
        }
      })
    }
  }, [])

  // Implicit continuation list (the show/list the user is playing through). Queued
  // episodes always play first; when Up Next drains, this picks back up where it was.
  const sessionRef = useRef<{ tracks: PodcastTrack[]; index: number }>({ tracks: [], index: 0 })

  const play = useCallback((newTrack: PodcastTrack, startSec = 0) => {
    sessionRef.current = { tracks: [newTrack], index: 0 }
    playTrackAt(newTrack, startSec)
  }, [playTrackAt])

  const playQueue = useCallback((tracks: PodcastTrack[], index = 0, startSec = 0) => {
    if (tracks.length === 0) return
    const i = Math.max(0, Math.min(index, tracks.length - 1))
    sessionRef.current = { tracks, index: i }
    playTrackAt(tracks[i]!, startSec)
  }, [playTrackAt])

  const playAllIntoQueue = useCallback((tracks: PodcastTrack[]) => {
    if (tracks.length === 0) return
    sessionRef.current = { tracks: [tracks[0]!], index: 0 }
    playTrackAt(tracks[0]!, 0)
    const rest = tracks.slice(1)
    setQueue(rest)
    void replaceQueue(rest.map(t => t.episodeId)).then(applyQueueResult).catch(() => {})
  }, [playTrackAt, applyQueueResult])

  const enqueue = useCallback((t: PodcastTrack) => {
    setQueue(prev => prev.some(q => q.episodeId === t.episodeId) ? prev : [...prev, t])
    void addToQueue(t.episodeId, 'last').then(applyQueueResult)
      .catch(() => toast.error('Could not add to the queue.'))
  }, [applyQueueResult])

  const playNextInQueue = useCallback((t: PodcastTrack) => {
    setQueue(prev => [t, ...prev.filter(q => q.episodeId !== t.episodeId)])
    void addToQueue(t.episodeId, 'next').then(applyQueueResult)
      .catch(() => toast.error('Could not add to the queue.'))
  }, [applyQueueResult])

  const removeFromQueue = useCallback((episodeId: string) => {
    setQueue(prev => prev.filter(q => q.episodeId !== episodeId))
    void removeQueueItem(episodeId).then(applyQueueResult).catch(() => {})
  }, [applyQueueResult])

  const reorderQueue = useCallback((episodeIds: string[]) => {
    setQueue(prev => {
      const byId = new Map(prev.map(t => [t.episodeId, t]))
      const ordered = episodeIds.map(id => byId.get(id)).filter((t): t is PodcastTrack => !!t)
      const missing = prev.filter(t => !episodeIds.includes(t.episodeId))
      return [...ordered, ...missing]
    })
    void reorderQueueApi(episodeIds).catch(() => toast.error('Could not reorder the queue.'))
  }, [])

  const clearQueue = useCallback(() => {
    setQueue([])
    void clearQueueApi().catch(() => {})
  }, [])

  const playFromQueue = useCallback((episodeId: string) => {
    const q = queueRef.current
    const i = q.findIndex(t => t.episodeId === episodeId)
    if (i < 0) return
    playTrackAt(q[i]!, 0)
    const rest = q.slice(i + 1)
    setQueue(rest)
    void replaceQueue(rest.map(t => t.episodeId)).then(applyQueueResult).catch(() => {})
  }, [playTrackAt, applyQueueResult])

  /** Advance: queued episodes first; then continue the implicit session list; else stop. */
  const advance = useCallback(() => {
    const head = queueRef.current[0]
    if (head) {
      // Playing from Up Next leaves sessionRef alone, so a show being listened through
      // resumes after the queue drains.
      playTrackAt(head, 0)
      setQueue(prev => prev.slice(1))
      void removeQueueItem(head.episodeId).then(applyQueueResult).catch(() => {})
      return
    }
    const s = sessionRef.current
    if (s.index + 1 < s.tracks.length) {
      s.index += 1
      playTrackAt(s.tracks[s.index]!, 0)
      return
    }
    setPlaying(false)
  }, [playTrackAt, applyQueueResult])

  const next = useCallback(() => { advance() }, [advance])

  const prev = useCallback(() => {
    const el = audioRef.current
    if (el) el.currentTime = 0
    setPositionSec(0)
  }, [])

  const pause = useCallback(() => {
    audioRef.current?.pause()
    setPlaying(false)
    reportTimeSaved(takeSavedSeconds())
  }, [])
  const resume = useCallback(() => {
    const el = audioRef.current
    if (el) resetPodcastVolume(el)
    sleepFadeStarted.current = false
    el?.play().catch(() => {})
    setPlaying(true)
  }, [])
  const toggle = useCallback(() => { setPlaying(p => !p) }, [])

  const seek = useCallback((sec: number) => {
    if (audioRef.current) audioRef.current.currentTime = sec
    setPositionSec(sec)
  }, [])

  const setRate = useCallback((r: number) => {
    setRateState(r)
    setPodcastBaseRate(r)
    if (audioRef.current) audioRef.current.playbackRate = r
  }, [])

  // ── Chapters ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!track) { setChapters([]); return }
    if (track.chapters?.length) { setChapters(track.chapters); return }
    setChapters([])
    let alive = true
    getChapters(track.episodeId).then(ch => { if (alive) setChapters(ch) }).catch(() => {})
    return () => { alive = false }
  }, [track?.episodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const currentChapterIndex = useCallback((pos: number): number => {
    const ch = chaptersRef.current
    for (let i = ch.length - 1; i >= 0; i--) if (pos >= ch[i]!.startSec) return i
    return -1
  }, [])

  const nextChapter = useCallback(() => {
    const ch = chaptersRef.current
    const i = currentChapterIndex(posRef.current)
    if (i + 1 < ch.length) seek(ch[i + 1]!.startSec)
    else advance()
  }, [currentChapterIndex, seek, advance])

  const prevChapter = useCallback(() => {
    const ch = chaptersRef.current
    const i = currentChapterIndex(posRef.current)
    // Within the first 3s of a chapter, jump to the previous one (music-player convention).
    if (i >= 0 && posRef.current - ch[i]!.startSec > 3) seek(ch[i]!.startSec)
    else if (i > 0) seek(ch[i - 1]!.startSec)
    else seek(0)
  }, [currentChapterIndex, seek])

  // ── Sleep timer ────────────────────────────────────────────────────────────────
  const setSleep = useCallback((mode: SleepMode, minutes?: number) => {
    sleepFadeStarted.current = false
    const el = audioRef.current
    if (el) resetPodcastVolume(el)
    if (mode === 'timer' && minutes && minutes > 0) {
      setSleepState({ mode, minutes, until: Date.now() + minutes * 60_000 })
    } else if (mode === 'episode' || mode === 'chapter') {
      setSleepState({ mode })
    } else {
      setSleepState({ mode: 'off' })
    }
  }, [])

  const sleepTrigger = useCallback(() => {
    const el = audioRef.current
    el?.pause()
    setPlaying(false)
    setSleepState({ mode: 'off' })
    sleepFadeStarted.current = false
    // Restore volume AFTER pausing so the fade never leaves a silent player behind.
    if (el) resetPodcastVolume(el)
  }, [])

  useEffect(() => {
    if (sleep.mode === 'off') return
    const iv = setInterval(() => {
      const el = audioRef.current
      if (!el || el.paused) return
      const s = sleepRef.current
      let remaining = Infinity
      if (s.mode === 'timer' && s.until) {
        remaining = (s.until - Date.now()) / 1000
      } else if (s.mode === 'episode') {
        const total = durRef.current || trackRef.current?.durationSec || 0
        if (total > 0) remaining = (total - posRef.current) / Math.max(0.25, el.playbackRate)
      } else if (s.mode === 'chapter') {
        const ch = chaptersRef.current
        const i = currentChapterIndex(posRef.current)
        const total = durRef.current || trackRef.current?.durationSec || 0
        const end = i + 1 < ch.length ? ch[i + 1]!.startSec : total
        if (end > 0) remaining = (end - posRef.current) / Math.max(0.25, el.playbackRate)
      }
      if (remaining <= 0.5) { sleepTrigger(); return }
      // Gentle fade across the final 15 seconds.
      if (remaining <= SLEEP_FADE_SEC && !sleepFadeStarted.current) {
        sleepFadeStarted.current = true
        fadePodcastVolume(el, 0.02, remaining)
      }
    }, 500)
    return () => clearInterval(iv)
  }, [sleep.mode, sleepTrigger, currentChapterIndex])

  const refreshShowSettings = useCallback((showId: string) => {
    void loadShowSettings(showId, true).then(s => {
      if (trackRef.current?.showId === showId) setShowSettings(s)
    })
  }, [])

  const close = useCallback(() => {
    const el = audioRef.current
    if (el && track) void saveWatchState(track.episodeId, el.currentTime, false)
    el?.pause()
    reportTimeSaved(takeSavedSeconds())
    sessionRef.current = { tracks: [], index: 0 }
    setTrack(null); setPlaying(false); setPositionSec(0)
    setSleepState({ mode: 'off' })
  }, [track])

  const closeIfShow = useCallback((showId: string) => {
    if (!showId) return
    // Loaded track belongs to the deleted show → tear the player down entirely.
    if (track?.showId === showId) { close(); return }
    // Otherwise just drop any of its episodes still sitting in Up Next / the session list.
    const stale = queueRef.current.filter(q => q.showId === showId)
    if (stale.length) {
      setQueue(prev => prev.filter(q => q.showId !== showId))
      for (const s of stale) void removeQueueItem(s.episodeId).catch(() => {})
    }
    const s = sessionRef.current
    if (s.tracks.some(t => t.showId === showId)) {
      const current = s.tracks[s.index]
      const kept = s.tracks.filter(t => t.showId !== showId)
      sessionRef.current = { tracks: kept, index: current ? Math.max(0, kept.indexOf(current)) : 0 }
    }
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
      // Math.abs so a backward seek also persists (a forward-only gate would skip saving until
      // the playhead climbs back past the last-saved position).
      if (track && Math.abs(el.currentTime - lastSaved.current) >= 10) {
        lastSaved.current = el.currentTime
        void saveWatchState(track.episodeId, el.currentTime, false)
      }
      // Per-show outro skip: end the episode early once the playhead enters the outro.
      const s = showSettingsRef.current
      const total = el.duration || durRef.current || 0
      if (s.skipOutroSec > 0 && total > 60 && !outroFired.current && el.currentTime >= total - s.skipOutroSec) {
        outroFired.current = true
        if (track) void saveWatchState(track.episodeId, 0, true)
        if (sleepRef.current.mode === 'episode' || sleepRef.current.mode === 'chapter') sleepTrigger()
        else if (autoplayRef.current) advance()
        else { el.pause(); setPlaying(false) }
      }
    }
    const onMeta = () => setDuration(el.duration || 0)
    const onPlay = () => {
      // Gesture-adjacent moment: build (or resume) the Web-Audio chain.
      ensurePodcastGraph(el)
      setPodcastBaseRate(el.playbackRate)
    }
    const onEnded = () => {
      if (track) void saveWatchState(track.episodeId, 0, true)
      reportTimeSaved(takeSavedSeconds())
      if (sleepRef.current.mode === 'episode' || sleepRef.current.mode === 'chapter') { sleepTrigger(); return }
      if (autoplayRef.current) advance()
      else setPlaying(false)
    }
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('durationchange', onMeta)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('play', onPlay)
    el.addEventListener('ended', onEnded)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('durationchange', onMeta)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('ended', onEnded)
    }
  }, [track?.episodeId, advance, sleepTrigger]) // eslint-disable-line react-hooks/exhaustive-deps

  // Trim-silence bookkeeping: flush saved seconds to the server on a slow heartbeat.
  useEffect(() => {
    const iv = setInterval(() => reportTimeSaved(takeSavedSeconds()), 30_000)
    return () => clearInterval(iv)
  }, [])

  // ── Mini-player integration: podcasts behave like radio/YouTube ─────────────────
  // Expose transport so a device player bar (via useBrowserSession → dispatchTransport) can
  // drive it, and fully evict (not just pause) when another source acquires audio — only
  // one source's mini bar should ever be docked at a time, matching radio/YouTube.
  const ctrlRef = useRef({ toggle, next, prev, seek, close })
  ctrlRef.current = { toggle, next, prev, seek, close }
  useEffect(() => {
    const unT = registerTransport('podcast', {
      toggle: () => ctrlRef.current.toggle(),
      next: () => ctrlRef.current.next(),
      prev: () => ctrlRef.current.prev(),
      seek: (s) => ctrlRef.current.seek(s),
      stop: () => ctrlRef.current.close(),
    })
    const unS = registerMediaStop('podcast', () => ctrlRef.current.close())
    // Duck the episode under companion speech on this device (lib/speechDucking.ts).
    const unD = registerDuckable('podcast', {
      duck: () => duckPodcastForSpeech(),
      restore: () => unduckPodcastAfterSpeech(),
    })
    return () => { unT(); unS(); unD() }
  }, [])

  // Report now-playing to the shared snapshot so device player bars reflect the podcast.
  const npRef = useRef({ positionSec, duration })
  npRef.current = { positionSec, duration }
  useEffect(() => {
    if (!track) return
    const report = () => {
      void fetch('/api/pod/now-playing', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'podcast', sessionId: sessionIdRef.current, title: track.title, artist: track.showName, cover: track.coverUrl ?? '',
          positionSec: Math.round(npRef.current.positionSec), durationSec: Math.round(npRef.current.duration),
          playing,
        }),
      }).catch(() => {})
    }
    report()
    const iv = setInterval(report, 4000)
    return () => clearInterval(iv)
  }, [track?.episodeId, track?.title, track?.showName, track?.coverUrl, playing]) // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the device to drop/hide its media bar when THIS tab's podcast stops — otherwise the
  // last reported snapshot just sits there until its 5-minute staleness timeout. Only fires on
  // a true had-track→no-track transition (never on initial mount), so a fresh tab loading with
  // no track doesn't wipe out a podcast another tab is legitimately still playing.
  const hadTrack = useRef(false)
  useEffect(() => {
    if (track) { hadTrack.current = true; return }
    if (!hadTrack.current) return
    hadTrack.current = false
    void fetch('/api/pod/now-playing/clear', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'podcast', sessionId: sessionIdRef.current }),
    }).catch(() => {})
  }, [track])

  const value = useMemo<PodcastPlaybackCtx>(() => ({
    track, playing, positionSec, duration, rate, autoplay, queue, chapters, showSettings, sleep, audioRef,
    play, playQueue, playAllIntoQueue, enqueue, playNextInQueue, playFromQueue, removeFromQueue, reorderQueue, clearQueue,
    next, prev, nextChapter, prevChapter, pause, resume, toggle, seek, setRate, setAutoplay, setSleep,
    refreshShowSettings, close, closeIfShow,
  }), [track, playing, positionSec, duration, rate, autoplay, queue, chapters, showSettings, sleep,
       play, playQueue, playAllIntoQueue, enqueue, playNextInQueue, playFromQueue, removeFromQueue, reorderQueue, clearQueue,
       next, prev, nextChapter, prevChapter, pause, resume, toggle, seek, setRate, setAutoplay, setSleep,
       refreshShowSettings, close, closeIfShow])

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
