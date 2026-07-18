// Cut-only preview engine (v1a): one <video> element whose src/currentTime follow the
// playhead through the EDL. A rAF clock advances timeline time while playing; at each
// cut the element swaps to the next clip's source and seeks its in-point. Crossfades
// and the dual-element engine arrive with v1b.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, Scissors, SkipBack } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEditor } from '@/components/videostudio/editorStore'
import { edlDurationSec, locate } from '@/components/videostudio/edl'
import { studioStreamUrl } from '@/lib/videos/studioApi'
import { useCompatSource } from '@/hooks/use-compat-source'

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const t = Math.floor((sec % 1) * 10)
  return `${m}:${String(s).padStart(2, '0')}.${t}`
}

export function PreviewPlayer() {
  const { state, setPlayhead } = useEditor()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const raf = useRef<number | null>(null)
  const lastTick = useRef<number>(0)

  const total = useMemo(() => edlDurationSec(state.edl), [state.edl])
  const loc = useMemo(() => locate(state.edl, state.playheadSec), [state.edl, state.playheadSec])
  const activeClip = loc ? state.edl.video[loc.index] ?? null : null

  // Uploaded bin sources can be mkv/mov/hevc the browser can't decode: on a media error
  // this swaps to (and if needed, queues) a server-transcoded rendition of the clip.
  const compat = useCompatSource(videoRef, activeClip ? `/api/videos/studio/media/${activeClip.assetId}/compat` : null)

  // Keep the element bound to the active clip's source + position. Only hard-seek when
  // the drift is visible (paused scrubbing or a cut); while playing, the element's own
  // clock is the source of truth between cuts.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !activeClip || !loc) return
    const want = studioStreamUrl(activeClip.assetId)
    const absolute = new URL(want, window.location.origin).href
    if (compat.active) {
      // The compat hook re-pointed the element at a transcoded rendition; keep clock
      // duties but never fight it over src.
      video.playbackRate = activeClip.speed
      video.muted = activeClip.muted
      return
    }
    if (video.src !== absolute) {
      video.src = want
      video.currentTime = loc.sourceSec
      video.playbackRate = activeClip.speed
      video.muted = activeClip.muted
      if (playing) void video.play().catch(() => setPlaying(false))
      return
    }
    video.playbackRate = activeClip.speed
    video.muted = activeClip.muted
    if (!playing && Math.abs(video.currentTime - loc.sourceSec) > 0.08) {
      video.currentTime = loc.sourceSec
    }
  }, [activeClip, loc, playing, compat.active])

  // rAF master clock: advance the timeline playhead while playing; swap clips at cuts.
  useEffect(() => {
    if (!playing) {
      if (raf.current) cancelAnimationFrame(raf.current)
      raf.current = null
      videoRef.current?.pause()
      return
    }
    const video = videoRef.current
    if (!video || !activeClip) { setPlaying(false); return }
    void video.play().catch(() => setPlaying(false))
    lastTick.current = performance.now()

    const tick = (now: number) => {
      const dt = (now - lastTick.current) / 1000
      lastTick.current = now
      const nextSec = state.playheadSec + dt
      if (nextSec >= total) {
        setPlayhead(total)
        setPlaying(false)
        return
      }
      setPlayhead(nextSec)
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clock restarts on play toggle only
  }, [playing])

  const { splitAtPlayhead } = useEditor()
  const empty = state.edl.video.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-card bg-black">
        {empty ? (
          <p className="p-8 text-center text-sm text-white/50">Add media from the bin to start editing.</p>
        ) : (
          <>
            <video ref={videoRef} playsInline className="max-h-full max-w-full" />
            {(compat.preparing || compat.failed) && (
              <span aria-live="polite"
                className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs font-medium text-white">
                {compat.failed ? 'Couldn’t convert this clip' : `Making playable…${compat.progressPct != null ? ` ${compat.progressPct}%` : ''}`}
              </span>
            )}
          </>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="outline" className="size-8 p-0" disabled={empty}
          onClick={() => { setPlaying(false); setPlayhead(0) }} title="Back to start">
          <SkipBack className="size-4" />
        </Button>
        <Button size="sm" className="size-8 p-0" disabled={empty}
          onClick={() => setPlaying((p) => !p)} title={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </Button>
        <Button size="sm" variant="outline" className="gap-1.5" disabled={empty}
          onClick={splitAtPlayhead} title="Split the clip under the playhead (S)">
          <Scissors className="size-4" /> Split
        </Button>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {fmtTime(state.playheadSec)} / {fmtTime(total)}
        </span>
      </div>
    </div>
  )
}
