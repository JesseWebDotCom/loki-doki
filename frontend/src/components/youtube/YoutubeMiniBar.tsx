import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Play, Pause, Maximize2, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { fileUrl, proxyStreamUrl, saveWatchState, ytImageProxy } from '@/lib/youtube/api'
import { thumbUrl, fmtClock } from '@/lib/youtube/format'

/**
 * Persistent docked mini-player for YouTube — shown app-wide once a video is handed off
 * (you navigate away from the watch page mid-playback). Mirrors the podcast player bar:
 * a single <video> element lives here and survives navigation, so playback continues.
 *
 * The live <video> sits over the small box in the bar; tapping the box pops it up into a
 * larger floating preview ABOVE the bar (the box then shows the thumbnail). It's the same
 * element repositioned by CSS — never re-parented — so toggling never reloads the stream.
 *
 * Embed videos can't persist, so the hand-off always plays through our privacy proxy
 * (native <video>) at the spot you left — hence a brief re-buffer and a 720p cap. The
 * bar hides on the watch/shorts routes, where a full player owns playback instead.
 */
export function YoutubeMiniBar() {
  const pb = useYoutubePlayback()
  const navigate = useNavigate()
  const location = useLocation()
  const videoRef = useRef<HTMLVideoElement>(null)
  const lastSave = useRef(0)
  const [playing, setPlaying] = useState(true)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(0)
  const [expanded, setExpanded] = useState(false)

  const track = pb.track
  // A full player owns playback on these routes — stay out of the way.
  const hidden = !track || location.pathname.startsWith('/youtube/watch') || location.pathname.startsWith('/youtube/shorts')

  // Source: offline file when available, otherwise the privacy-proxy stream (handles the
  // embed→proxy hand-off). Local audio has no video track, so show only the thumbnail.
  const isLocalAudio = track?.localKind === 'audio'
  const src = !track ? ''
    : track.localKind === 'audio' ? fileUrl(track.videoId, 'audio')
    : track.localKind === 'video' ? fileUrl(track.videoId, 'video')
    : proxyStreamUrl(track.videoId, 'video', 'auto')

  // Load + autoplay from the hand-off position whenever a new track docks.
  useEffect(() => {
    const el = videoRef.current
    if (!el || !track) return
    if (!el.src.endsWith(src)) { el.src = src }
    const onMeta = () => { try { el.currentTime = pb.startSec } catch { /* not seekable */ } }
    el.addEventListener('loadedmetadata', onMeta, { once: true })
    void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    return () => el.removeEventListener('loadedmetadata', onMeta)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.videoId, pb.startSec])

  // Position reporting + periodic watch-state save (so expanding back resumes precisely).
  useEffect(() => {
    const el = videoRef.current
    if (!el || !track) return
    const onTime = () => {
      setPos(el.currentTime); pb.reportPosition(el.currentTime)
      const now = Date.now()
      if (!el.paused && now - lastSave.current > 5000) {
        lastSave.current = now
        void saveWatchState(track.videoId, el.currentTime, false)
      }
    }
    const onDur = () => setDur(el.duration || 0)
    const onEnd = () => { void saveWatchState(track.videoId, 0, true); pb.close() }
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('durationchange', onDur)
    el.addEventListener('ended', onEnd)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('durationchange', onDur)
      el.removeEventListener('ended', onEnd)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.videoId])

  // Collapse the floating preview whenever the bar hides (route change / new track).
  useEffect(() => { if (hidden) setExpanded(false) }, [hidden])

  if (hidden) return null

  const total = dur || track!.durationSec || 0
  const pct = total > 0 ? (pos / total) * 100 : 0
  const toggle = () => {
    const el = videoRef.current; if (!el) return
    if (el.paused) { void el.play(); setPlaying(true) } else { el.pause(); setPlaying(false) }
  }
  const goWatch = () => navigate(`/youtube/watch/${track!.videoId}${track!.localKind ? `?k=${track!.localKind}` : ''}`)
  const onClose = () => { const el = videoRef.current; if (el) void saveWatchState(track!.videoId, el.currentTime, false); pb.close() }

  return (
    <div className="relative z-40 shrink-0 border-t border-border/60 bg-background/95 backdrop-blur-md shadow-[0_-2px_12px_rgba(0,0,0,0.08)]">
      {/* Scrubber */}
      <div className="group absolute -top-1 left-0 h-2 w-full cursor-pointer"
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); const el = videoRef.current; if (el && total > 0) el.currentTime = ((e.clientX - r.left) / r.width) * total }}>
        <div className="absolute top-1 h-0.5 w-full bg-muted" />
        <div className="absolute top-1 h-0.5 bg-[var(--yt-accent)]" style={{ width: `${pct}%` }} />
      </div>

      {/* The single live <video>, repositioned by CSS: collapsed it overlays the small box;
          expanded it floats above the bar. Hidden entirely for local audio (no picture). */}
      {!isLocalAudio && (
        <video ref={videoRef} playsInline onClick={() => setExpanded(e => !e)}
          title={expanded ? 'Shrink' : 'Pop out'}
          className={cn('absolute z-50 cursor-pointer rounded-md bg-black object-cover shadow-lg transition-all',
            expanded ? 'bottom-[calc(100%+0.5rem)] left-4 aspect-video w-72' : 'bottom-2 left-4 aspect-video h-12')} />
      )}

      <div className="flex items-center gap-3 px-4 py-2">
        {/* Small box — the thumbnail. The live <video> sits on top of it when collapsed;
            when expanded the video floats up and this thumbnail shows through. */}
        <button onClick={() => !isLocalAudio && setExpanded(e => !e)} className="relative aspect-video h-12 shrink-0 overflow-hidden rounded-md bg-black" aria-label="Pop out video">
          <img src={ytImageProxy(thumbUrl(track!.videoId, 'mq'))} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
        </button>

        <button onClick={goWatch} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-semibold">{track!.title}</p>
          <p className="truncate text-xs text-muted-foreground">{track!.author ?? 'YouTube'}</p>
        </button>

        <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
          {fmtClock(pos)} / {fmtClock(total)}
        </span>

        <div className="flex items-center gap-1">
          <button onClick={toggle} className="grid size-9 place-items-center rounded-full bg-foreground text-background hover:opacity-90" aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
          </button>
          <button onClick={goWatch} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground" aria-label="Open full player"><Maximize2 className="size-4" /></button>
          <button onClick={onClose} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground" aria-label="Close"><X className="size-3.5" /></button>
        </div>
      </div>
    </div>
  )
}
