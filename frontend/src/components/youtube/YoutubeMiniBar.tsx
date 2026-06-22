import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Play, Pause, Maximize2, X, Loader2, SkipBack, SkipForward } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useYoutubePlayback } from '@/context/YoutubePlaybackContext'
import { fileUrl, saveWatchState, ytImageProxy } from '@/lib/youtube/api'
import { thumbUrl, fmtClock } from '@/lib/youtube/format'
import { loadYTApi } from '@/lib/youtube/ytapi'
import { ChannelAvatar } from '@/components/youtube/media'

/**
 * Persistent docked mini-player for YouTube — shown app-wide once a video is handed off
 * (you navigate away from the watch page mid-playback). Mirrors the podcast player bar:
 * the player element lives here and survives navigation, so playback continues.
 *
 * Online videos play via the YouTube IFrame embed (starts in ~1–2s, full quality, no
 * yt-dlp). Offline saves play from the local file via a <video>. A transparent overlay on
 * top of the player surfaces our own gestures (tap to pop out, drag to move) since the
 * iframe would otherwise swallow clicks; our own buttons drive play/pause.
 *
 * The bar hides on the watch/shorts routes, where a full player owns playback instead.
 */
export function YoutubeMiniBar() {
  const pb = useYoutubePlayback()
  const pbRef = useRef(pb); pbRef.current = pb // latest pb for use inside player event closures
  const navigate = useNavigate()
  const location = useLocation()
  const hostRef = useRef<HTMLDivElement>(null)   // online: YT iframe mounts in here
  const ytRef = useRef<any>(null)
  const videoRef = useRef<HTMLVideoElement>(null) // offline: local file
  const lastSave = useRef(0)
  const [playing, setPlaying] = useState(true)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [win, setWin] = useState<{ x: number; y: number } | null>(null)
  const [winW, setWinW] = useState(288) // expanded width (px); height tracks 16:9
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const resize = useRef<{ sx: number; ow: number } | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const scrubbing = useRef(false)

  const track = pb.track
  const online = !!track && !track.localKind
  const isLocalAudio = track?.localKind === 'audio'
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
            if (e.data === 1) { setPlaying(true); setLoading(false) }   // playing
            else if (e.data === 2) setPlaying(false)                    // paused
            else if (e.data === 3) setLoading(true)                     // buffering
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
    if (!track || online) return
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
  }, [track?.videoId, online])

  // ── Position reporting + watch-state save (both backends) ─────────────────────
  const read = () => {
    if (online) { const y = ytRef.current; if (y?.getCurrentTime) { try { return { t: y.getCurrentTime() || 0, d: y.getDuration?.() || 0, playing: y.getPlayerState?.() === 1 } } catch { /* not ready */ } } }
    else { const v = videoRef.current; if (v) return { t: v.currentTime || 0, d: v.duration || 0, playing: !v.paused } }
    return null
  }
  useEffect(() => {
    if (!track || hidden) return
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
  }, [track?.videoId, online, hidden])

  // Collapse / re-anchor the floating preview whenever the bar hides.
  useEffect(() => { if (hidden) { setExpanded(false); setWin(null) } }, [hidden])

  if (hidden) return null

  const total = dur || track!.durationSec || 0
  const pct = total > 0 ? (pos / total) * 100 : 0
  const seekTo = (sec: number) => { if (online) ytRef.current?.seekTo?.(sec, true); else if (videoRef.current) videoRef.current.currentTime = sec }
  const togglePlay = () => {
    const s = read(); if (!s) return
    if (online) { const y = ytRef.current; if (s.playing) { y?.pauseVideo?.(); setPlaying(false) } else { y?.playVideo?.(); setPlaying(true) } }
    else { const v = videoRef.current; if (!v) return; if (v.paused) { void v.play(); setPlaying(true) } else { v.pause(); setPlaying(false) } }
  }
  const goWatch = () => navigate(`/youtube/watch/${track!.videoId}${track!.localKind ? `?k=${track!.localKind}` : ''}`)
  const onClose = () => { const s = read(); if (s) void saveWatchState(track!.videoId, s.t, false); pb.close() }
  // Skip through the queue (auto-play "Up next"). Prev restarts the current if you're past
  // a few seconds in, otherwise steps back.
  const skipNext = () => { if (pb.hasNext) pb.next() }
  const skipPrev = () => { const s = read(); if (s && s.t > 3) seekTo(0); else if (pb.hasPrev) pb.prev(); else seekTo(0) }

  // Pop-out window: tap toggles size; once expanded it can be dragged & resized on screen.
  const winH = Math.round(winW * 9 / 16)
  const toggleExpand = () => { if (isLocalAudio) return; if (expanded) { setExpanded(false); setWin(null) } else setExpanded(true) }
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

  // Resize the expanded window from its bottom-right corner (keeps 16:9).
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

  // Draggable progress bar — click or drag anywhere along it to scrub.
  const scrubFrom = (clientX: number) => {
    const el = barRef.current; if (!el || total <= 0) return
    const r = el.getBoundingClientRect()
    const frac = Math.max(0, Math.min((clientX - r.left) / r.width, 1))
    seekTo(frac * total); setPos(frac * total)
  }
  const onScrubDown = (e: React.PointerEvent) => { scrubbing.current = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); scrubFrom(e.clientX) }
  const onScrubMove = (e: React.PointerEvent) => { if (scrubbing.current) scrubFrom(e.clientX) }
  const onScrubUp = (e: React.PointerEvent) => { scrubbing.current = false; try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* not captured */ } }

  // Shared positioning for the player, its interaction overlay, and the spinner.
  const posClass = !expanded
    ? 'absolute bottom-2 left-4 h-12 aspect-video'
    : win ? 'fixed aspect-video' : 'absolute bottom-[calc(100%+0.5rem)] left-4 aspect-video'
  const posStyle = expanded
    ? { width: winW, ...(win ? { top: win.y, left: win.x } : {}) }
    : undefined

  return (
    // Outer wrapper has NO backdrop-filter/transform, so the dragged (position:fixed) player
    // is positioned relative to the viewport — not trapped inside the blurred bar's box.
    <div className="relative z-40 shrink-0">
      {!isLocalAudio && (
        <>
          {/* The player element (YT iframe host for online, <video> for offline). Repositioned
              by CSS: collapsed it overlays the small box; expanded it floats; dragged it goes
              fixed anywhere. Never re-parented, so it never reloads. */}
          {online
            ? <div ref={hostRef} className={cn(posClass, expanded && win ? 'z-[60]' : 'z-50', !win && 'transition-all', 'overflow-hidden rounded-md bg-black shadow-lg')} style={posStyle} />
            : <video ref={videoRef} playsInline className={cn(posClass, expanded && win ? 'z-[60]' : 'z-50', !win && 'transition-all', 'rounded-md bg-black object-cover shadow-lg')} style={posStyle} />}

          {/* Transparent gesture surface on top — tap toggles size, drag moves (when expanded).
              Sits above the iframe so it captures our gestures instead of YouTube's UI. */}
          <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
            title={expanded ? 'Drag to move • tap to shrink' : 'Pop out'}
            className={cn(posClass, expanded && win ? 'z-[61]' : 'z-[51]', !win && 'transition-all',
              'touch-none select-none cursor-pointer rounded-md')}
            style={posStyle}>
            {/* Grabber-handle hint that the video pops out (collapsed only). */}
            {!expanded && !loading && (
              <span className="absolute bottom-1 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full bg-white/80 shadow-[0_0_4px_rgba(0,0,0,0.6)]" />
            )}
            {/* Resize grip (expanded only). */}
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
          {/* Small box — the thumbnail. The player sits on top of it when collapsed; when
              expanded the player floats up and this thumbnail shows through. */}
          <button onClick={toggleExpand} className="relative aspect-video h-12 shrink-0 overflow-hidden rounded-md bg-black" aria-label="Pop out video">
            <img src={ytImageProxy(thumbUrl(track!.videoId, 'mq'))} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
          </button>

          <button onClick={goWatch} className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm font-semibold">{track!.title}</p>
            <span className="mt-0.5 flex items-center gap-1.5">
              <ChannelAvatar title={track!.author ?? ''} src={track!.channelThumb} className="size-4 shrink-0 text-[8px]" />
              <span className="truncate text-xs text-muted-foreground">{track!.author ?? 'YouTube'}</span>
            </span>
          </button>

          <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
            {fmtClock(pos)} / {fmtClock(total)}
          </span>

          <div className="flex flex-col items-stretch gap-1.5">
            <div className="flex items-center justify-end gap-1">
              <button onClick={skipPrev} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground" aria-label="Previous"><SkipBack className="size-4" /></button>
              <button onClick={togglePlay} className="grid size-9 place-items-center rounded-full bg-foreground text-background hover:opacity-90" aria-label={playing ? 'Pause' : 'Play'}>
                {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
              </button>
              <button onClick={skipNext} disabled={!pb.hasNext} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="Next"><SkipForward className="size-4" /></button>
              <button onClick={goWatch} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground" aria-label="Open full player"><Maximize2 className="size-4" /></button>
              <button onClick={onClose} className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground" aria-label="Close"><X className="size-3.5" /></button>
            </div>
            {/* Draggable progress bar — under the controls; click or drag to scrub. */}
            <div ref={barRef} onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp}
              className="group relative flex h-3 cursor-pointer touch-none items-center">
              <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/20">
                <div className="h-full rounded-full bg-red-600" style={{ width: `${pct}%` }} />
              </div>
              <span className="absolute size-3 -translate-x-1/2 rounded-full bg-red-600 shadow transition-transform group-hover:scale-110" style={{ left: `${pct}%` }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
