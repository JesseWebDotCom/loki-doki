import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Play, Pause, Maximize2, X, Loader2, SkipBack, SkipForward } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { useRadio } from '@/context/RadioContext'
import { RadioMiniBar } from '@/components/music/RadioMiniBar'
import { fileUrl, saveWatchState, ytImageProxy } from '@/lib/youtube/api'
import { proxyImg } from '@/lib/img'
import { thumbUrl, fmtClock } from '@/lib/youtube/format'
import { loadYTApi } from '@/lib/youtube/ytapi'
import { ChannelAvatar } from '@/components/youtube/media'
import { SeekBar } from '@/components/shared/SeekBar'

/**
 * Persistent docked mini-player — shown app-wide for YouTube videos AND internet radio streams.
 *
 * Three backends:
 *  - Online YouTube: YouTube IFrame embed (videoId, no localKind, no streamUrl)
 *  - Offline saved:  local <video> via fileUrl()   (localKind = 'audio' | 'video')
 *  - Live stream:    <audio src={streamUrl}>       (streamUrl set, no IFrame, no progress bar)
 */
export function YoutubeMiniBar() {
  const pb = useYoutubePlayback()
  const radio = useRadio()
  const pbRef = useRef(pb); pbRef.current = pb
  const navigate = useNavigate()
  const location = useLocation()
  const hostRef = useRef<HTMLDivElement>(null)
  const ytRef = useRef<any>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioStreamRef = useRef<HTMLAudioElement>(null)
  const lastSave = useRef(0)
  const [playing, setPlaying] = useState(true)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [favErr, setFavErr] = useState(false)
  const [win, setWin] = useState<{ x: number; y: number } | null>(null)
  const [winW, setWinW] = useState(288)
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const resize = useRef<{ sx: number; ow: number } | null>(null)
  const scrubbing = useRef(false)

  const track = pb.track
  const isStream = !!track?.streamUrl
  const online = !!track && !track.localKind && !isStream
  const isLocalAudio = track?.localKind === 'audio'

  // When something asks to "play expanded" (e.g. a Shows/Movies trailer), pop the larger
  // player open. Only for real YouTube videos — local audio / live streams have no video.
  useEffect(() => {
    if (pb.expandRequest > 0 && online) setExpanded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pb.expandRequest])
  const hidden = !track || location.pathname.startsWith('/youtube/watch') || location.pathname.startsWith('/youtube/shorts')

  // ── Online: drive the YouTube IFrame embed ───────────────────────────────────
  useEffect(() => {
    if (!track || !online || hidden) return
    let cancelled = false
    setLoading(true)
    void loadYTApi().then(YT => {
      if (cancelled || !hostRef.current) return
      const host = document.createElement('div'); host.className = 'size-full'
      hostRef.current.innerHTML = ''; hostRef.current.appendChild(host)
      ytRef.current = new YT.Player(host, {
        videoId: track.videoId,
        playerVars: { autoplay: 1, start: Math.floor(pb.startSec) || 0, controls: 0, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: (e: any) => { try { e.target.playVideo?.(); setDur(e.target.getDuration?.() || 0) } catch { /* not ready */ } },
          onStateChange: (e: any) => {
            if (e.data === 1) { setPlaying(true); setLoading(false) }
            else if (e.data === 2) setPlaying(false)
            else if (e.data === 3) setLoading(true)
            if (e.data === YT.PlayerState?.ENDED) {
              void saveWatchState(track.videoId, 0, true)
              if (pbRef.current.hasNext) pbRef.current.next(); else pbRef.current.close()
            }
          },
        },
      })
    })
    return () => { cancelled = true; try { ytRef.current?.destroy?.() } catch { /* gone */ }; ytRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.videoId, online, hidden])

  // ── Offline: drive the local <video> ─────────────────────────────────────────
  useEffect(() => {
    if (!track || online || isStream) return
    const el = videoRef.current; if (!el) return
    setLoading(true)
    const src = fileUrl(track.videoId, track.localKind === 'audio' ? 'audio' : 'video')
    if (!el.src.endsWith(src)) el.src = src
    const onMeta = () => { try { el.currentTime = pb.startSec } catch { /* not seekable */ } }
    const onEnd = () => { void saveWatchState(track.videoId, 0, true); if (pbRef.current.hasNext) pbRef.current.next(); else pbRef.current.close() }
    el.addEventListener('loadedmetadata', onMeta, { once: true })
    el.addEventListener('ended', onEnd)
    void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    return () => { el.removeEventListener('loadedmetadata', onMeta); el.removeEventListener('ended', onEnd) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.videoId, online, isStream])

  // ── Live stream: drive the <audio> element ───────────────────────────────────
  useEffect(() => {
    if (!track || !isStream || hidden) return
    const el = audioStreamRef.current; if (!el) return
    setLoading(true); setPos(0); setDur(0)
    el.src = track.streamUrl!
    el.load()
    void el.play()
    return () => { el.pause(); el.removeAttribute('src') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.videoId, isStream, hidden])

  // ── Position reporting + watch-state save (online + offline only) ─────────────
  const read = () => {
    if (online) { const y = ytRef.current; if (y?.getCurrentTime) { try { return { t: y.getCurrentTime() || 0, d: y.getDuration?.() || 0, playing: y.getPlayerState?.() === 1 } } catch { /* not ready */ } } }
    else if (!isStream) { const v = videoRef.current; if (v) return { t: v.currentTime || 0, d: v.duration || 0, playing: !v.paused } }
    return null
  }
  useEffect(() => {
    if (!track || hidden || isStream) return
    const iv = setInterval(() => {
      const s = read(); if (!s) return
      if (!scrubbing.current) setPos(s.t)
      pb.reportPosition(s.t); if (s.d) setDur(s.d)
      if (s.playing) setLoading(false)
      const now = Date.now()
      if (s.playing && now - lastSave.current > 5000) { lastSave.current = now; void saveWatchState(track.videoId, s.t, false) }
    }, 500)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.videoId, online, hidden, isStream])

  useEffect(() => { if (hidden) { setExpanded(false); setWin(null) } }, [hidden])
  useEffect(() => { setFavErr(false) }, [track?.videoId])

  // Radio and YouTube are mutually exclusive audio — docking a video stops the station.
  useEffect(() => { if (track && radio.active) radio.stop() }, [track?.videoId]) // eslint-disable-line react-hooks/exhaustive-deps
  // ...and conversely, starting the radio closes any docked YouTube video, so the music doesn't
  // play behind the YouTube mini-bar. Keyed on the radio becoming active / changing song.
  useEffect(() => { if (radio.active && track) pb.close() }, [radio.active, radio.currentTrack?.videoId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Show the AI-Radio controller when a station is live, nothing's docked in the YT
  // player, and we're not already on the full radio tab.
  const onRadioTab = location.pathname === '/music' && new URLSearchParams(location.search).get('tab') === 'radio'
  const showRadio = radio.active && !track && !onRadioTab
    && !location.pathname.startsWith('/youtube/watch') && !location.pathname.startsWith('/youtube/shorts')
  if (showRadio) return <RadioMiniBar />

  if (hidden) return null

  const total = dur || track!.durationSec || 0
  const seekTo = (sec: number) => { if (online) ytRef.current?.seekTo?.(sec, true); else if (videoRef.current) videoRef.current.currentTime = sec }

  const togglePlay = () => {
    if (isStream) {
      const el = audioStreamRef.current; if (!el) return
      if (el.paused) { void el.play(); setPlaying(true) } else { el.pause(); setPlaying(false) }
      return
    }
    const s = read(); if (!s) return
    if (online) { const y = ytRef.current; if (s.playing) { y?.pauseVideo?.(); setPlaying(false) } else { y?.playVideo?.(); setPlaying(true) } }
    else { const v = videoRef.current; if (!v) return; if (v.paused) { void v.play(); setPlaying(true) } else { v.pause(); setPlaying(false) } }
  }

  const goWatch = () => {
    if (isStream) { navigate('/music'); return }
    navigate(
      `/youtube/watch/${track!.videoId}${track!.localKind ? `?k=${track!.localKind}` : ''}`,
      { state: { title: track!.title, author: track!.author, channelThumb: track!.channelThumb ?? null } },
    )
  }

  // Toggle native fullscreen on the actual video surface — the YouTube IFrame itself (online;
  // it carries allowfullscreen) or the <video> element (offline). Exits if already fullscreen
  // so the same button works both ways. The mini-player keeps playing.
  const goFullscreen = () => {
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void }
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      try { (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document) } catch { /* noop */ }
      return
    }
    type FsEl = Element & {
      requestFullscreen?: () => Promise<void>
      webkitRequestFullscreen?: () => void
      webkitEnterFullscreen?: () => void
    }
    const el: FsEl | null = online
      ? ((hostRef.current?.querySelector('iframe') as FsEl | null) ?? (hostRef.current as FsEl | null))
      : (videoRef.current as FsEl | null)
    if (!el) return
    const req = el.requestFullscreen ?? el.webkitRequestFullscreen ?? el.webkitEnterFullscreen
    try { req?.call(el) } catch { /* fullscreen denied — ignore */ }
  }

  const onClose = () => {
    if (!isStream) { const s = read(); if (s) void saveWatchState(track!.videoId, s.t, false) }
    if (isStream) { audioStreamRef.current?.pause() }
    pb.close()
  }

  const skipNext = () => { if (pb.hasNext) pb.next() }
  const skipPrev = () => { const s = read(); if (s && s.t > 3) seekTo(0); else if (pb.hasPrev) pb.prev(); else seekTo(0) }

  const winH = Math.round(winW * 9 / 16)
  const toggleExpand = () => { if (isLocalAudio || isStream) return; if (expanded) { setExpanded(false); setWin(null) } else setExpanded(true) }
  const onDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement
    if (expanded) el.setPointerCapture(e.pointerId)
    const r = el.getBoundingClientRect()
    drag.current = { sx: e.clientX, sy: e.clientY, ox: win?.x ?? r.left, oy: win?.y ?? r.top, moved: false }
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || !expanded) return
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true
    if (d.moved) setWin({
      x: Math.max(8, Math.min(d.ox + dx, window.innerWidth - winW - 8)),
      y: Math.max(8, Math.min(d.oy + dy, window.innerHeight - winH - 8)),
    })
  }
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    if (d && !d.moved) toggleExpand()
  }
  const onResizeDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    resize.current = { sx: e.clientX, ow: winW }
  }
  const onResizeMove = (e: React.PointerEvent) => {
    const r = resize.current; if (!r) return
    e.stopPropagation()
    const max = Math.min(640, window.innerWidth - 32)
    setWinW(Math.max(200, Math.min(r.ow + (e.clientX - r.sx), max)))
  }
  const onResizeUp = (e: React.PointerEvent) => {
    if (!resize.current) return
    resize.current = null; e.stopPropagation()
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* not captured */ }
  }
  const posClass = !expanded
    ? 'absolute bottom-2 left-4 h-12 aspect-video'
    : win ? 'fixed aspect-video' : 'absolute bottom-[calc(100%+0.5rem)] left-4 aspect-video'
  const posStyle = expanded ? { width: winW, ...(win ? { top: win.y, left: win.x } : {}) } : undefined

  // Thumbnail: use override (station favicon/logo) if provided, else YouTube thumbnail.
  const thumbSrc = track!.thumbnail ?? ytImageProxy(thumbUrl(track!.videoId, 'mq'))

  return (
    <div className="relative z-40 shrink-0">
      {/* Stream audio (live radio / arbitrary URLs) */}
      <audio ref={audioStreamRef}
        onPlay={() => { setPlaying(true); setLoading(false) }}
        onPause={() => setPlaying(false)}
        onWaiting={() => setLoading(true)}
        onPlaying={() => { setPlaying(true); setLoading(false) }}
        onError={() => { setLoading(false); setPlaying(false) }}
      />

      {/* Video pop-out: only for online YouTube and offline video/audio (not stream) */}
      {!isLocalAudio && !isStream && (
        <>
          {online
            ? <div ref={hostRef} className={cn(posClass, expanded && win ? 'z-[60]' : 'z-50', !win && 'transition-all', 'overflow-hidden rounded-md bg-black shadow-lg')} style={posStyle} />
            : <video ref={videoRef} playsInline className={cn(posClass, expanded && win ? 'z-[60]' : 'z-50', !win && 'transition-all', 'rounded-md bg-black object-cover shadow-lg')} style={posStyle} />}

          <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
            title={expanded ? 'Drag to move • tap to shrink' : 'Pop out'}
            className={cn(posClass, expanded && win ? 'z-[61]' : 'z-[51]', !win && 'transition-all', 'touch-none select-none cursor-pointer rounded-md')}
            style={posStyle}>
            {!expanded && !loading && (
              <span className="absolute bottom-1 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full bg-white/80 shadow-[0_0_4px_rgba(0,0,0,0.6)]" />
            )}
            {expanded && (
              <span onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp}
                title="Drag to resize"
                className="absolute bottom-0 right-0 grid size-5 cursor-nwse-resize place-items-center">
                <span className="size-2.5 border-b-2 border-r-2 border-white/80" />
              </span>
            )}
          </div>

          {loading && (
            <div className={cn(posClass, expanded && win ? 'z-[62]' : 'z-[52]', 'pointer-events-none grid place-items-center rounded-md')} style={posStyle}>
              <Loader2 className="size-5 animate-spin text-white/80" />
            </div>
          )}
        </>
      )}

      {/* The visible bar */}
      <div className="relative border-t border-border/60 bg-background/95 backdrop-blur-md shadow-[0_-2px_12px_rgba(0,0,0,0.08)]">
        <div className="flex items-center gap-3 px-4 py-2">
          {/* Thumbnail / station art */}
          <button onClick={isStream ? goWatch : toggleExpand}
            className={cn(
              'relative shrink-0 overflow-hidden rounded-md bg-muted',
              isStream ? 'h-10 w-10' : 'aspect-video h-12',
            )}
            aria-label={isStream ? 'Go to radio' : 'Pop out video'}>
            {isStream ? (
              <>
                <div className="flex size-full items-center justify-center text-2xl leading-none">
                  {track!.icon ?? '📻'}
                </div>
                {track!.thumbnail && !favErr && (
                  <img src={proxyImg(track!.thumbnail)} alt="" className="absolute inset-0 size-full object-cover"
                    onError={() => setFavErr(true)} />
                )}
              </>
            ) : track!.thumbnail ? (
              <img src={thumbSrc} alt="" className="size-full object-cover" />
            ) : (
              <img src={thumbSrc} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
            )}
            {isStream && loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <Loader2 className="size-4 animate-spin text-white" />
              </div>
            )}
          </button>

          {/* Title + author */}
          <button onClick={goWatch} className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm font-semibold">{track!.title}</p>
            <span className="mt-0.5 flex items-center gap-1.5">
              {!isStream && <ChannelAvatar title={track!.author ?? ''} src={track!.channelThumb} className="size-4 shrink-0 text-[8px]" />}
              {isStream && <span className="inline-flex size-1.5 animate-pulse rounded-full bg-red-500" />}
              <span className="truncate text-xs text-muted-foreground">{track!.author ?? (isStream ? 'Live Radio' : 'YouTube')}</span>
            </span>
          </button>

          {/* Time (YouTube/offline only) */}
          {!isStream && (
            <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
              {fmtClock(pos)} / {fmtClock(total)}
            </span>
          )}

          <div className="flex flex-col items-stretch gap-1.5">
            <div className="flex items-center justify-end gap-1">
              {!isStream && (
                <button onClick={skipPrev} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground" aria-label="Previous">
                  <SkipBack className="size-4" />
                </button>
              )}
              <button onClick={togglePlay} className="grid size-9 place-items-center rounded-full bg-foreground text-background hover:opacity-90" aria-label={playing ? 'Pause' : 'Play'}>
                {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
              </button>
              {!isStream && (
                <button onClick={skipNext} disabled={!pb.hasNext} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="Next">
                  <SkipForward className="size-4" />
                </button>
              )}
              {!isStream && (
                <button onClick={goFullscreen} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground" aria-label="Fullscreen">
                  <Maximize2 className="size-4" />
                </button>
              )}
              <button onClick={onClose} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground" aria-label="Close">
                <X className="size-3.5" />
              </button>
            </div>

            {/* Progress bar — YouTube/offline only; streams are live */}
            {!isStream && (
              <SeekBar pos={pos} total={total} onSeek={seekTo}
                onScrubStateChange={(s) => { scrubbing.current = s }} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
