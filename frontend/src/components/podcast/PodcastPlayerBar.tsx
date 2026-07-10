import { useEffect, useRef, useState } from 'react'
import { Play, Pause, SkipBack, SkipForward, ChevronUp, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { ShowCover } from '@/components/podcast/ShowCover'
import { NowPlaying } from '@/components/podcast/NowPlaying'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { fmtTime } from '@/lib/podcast/format'
import { CompactMediaBar } from '@/components/shell/CompactMediaBar'

const POP_SIZE = 220 // px, fixed square - cover art has no natural aspect to resize like video

/**
 * Persistent slim player bar shown app-wide whenever a track is loaded - on
 * every route, including inside /podcasts alongside the full Now Playing
 * sidebar, so transport controls are always reachable without hunting for
 * the sidebar or resizing the window.
 *
 * Clicking the cover pops out a small draggable artwork window that floats
 * above the bar (mirrors the YouTube mini-player's pop-out), rather than
 * taking over the screen. The chevron still opens the full Now Playing sheet
 * (chapters/transcript/queue) for when more room is actually needed.
 */
export function PodcastPlayerBar() {
  const { track, playing, positionSec, duration, pause, resume, next, prev, seek, close } = usePodcastPlayback()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [popped, setPopped] = useState(false)
  const [win, setWin] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)

  useEffect(() => { if (!track) { setPopped(false); setWin(null); setSheetOpen(false) } }, [track])

  if (!track) return null
  const total = track.durationSec || duration || 0
  const pct = total > 0 ? (positionSec / total) * 100 : 0

  const togglePop = () => setPopped(p => !p)
  const onDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const r = el.getBoundingClientRect()
    drag.current = { sx: e.clientX, sy: e.clientY, ox: win?.x ?? r.left, oy: win?.y ?? r.top, moved: false }
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true
    if (d.moved) setWin({
      x: Math.max(8, Math.min(d.ox + dx, window.innerWidth - POP_SIZE - 8)),
      y: Math.max(8, Math.min(d.oy + dy, window.innerHeight - POP_SIZE - 8)),
    })
  }
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* not captured */ }
    if (d && !d.moved) togglePop()
  }
  const popStyle = win ? { top: win.y, left: win.x } : undefined

  return (
    <div className="relative z-40 shrink-0">
      {/* Pop-out artwork window - anchored above the bar until dragged elsewhere. */}
      {popped && (
        <div
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
          title="Drag to move • tap to shrink"
          className={cn(
            'touch-none select-none overflow-hidden rounded-card bg-black shadow-lg',
            win ? 'fixed z-[60]' : 'absolute bottom-[calc(100%+0.5rem)] left-4 z-[60]',
          )}
          style={{ width: POP_SIZE, height: POP_SIZE, ...popStyle }}
        >
          <ShowCover showId={track.showId ?? ''} title={track.showName} fill rounded="rounded-none" className="size-full" />
        </div>
      )}

      <div className="glass-chrome relative border-t border-border/60 shadow-[0_-2px_12px_rgba(0,0,0,0.08)]">
        {/* Scrubber */}
        <div
          className="group absolute -top-1 left-0 h-2 w-full cursor-pointer"
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect()
            if (total > 0) seek(((e.clientX - rect.left) / rect.width) * total)
          }}
        >
          <div className="absolute top-1 h-0.5 w-full bg-muted" />
          <div className="absolute top-1 h-0.5 bg-brand" style={{ width: `${pct}%` }} />
        </div>

        {/* Phone: shared compact row; tap opens the full Now Playing sheet. */}
        <CompactMediaBar
          art={<ShowCover showId={track.showId ?? ''} title={track.showName} fill rounded="rounded-none" className="size-full" />}
          title={track.title}
          subtitle={<span className="truncate">{track.showName}</span>}
          playing={playing}
          onToggle={playing ? pause : resume}
          onNext={next}
          onClose={close}
          onExpand={() => setSheetOpen(true)}
          expandLabel="Open player"
        />
        <div className="hidden md:flex items-center gap-3 px-4 py-2">
          <button onClick={togglePop} className="flex items-center gap-3 min-w-0 flex-1 text-left" aria-label="Pop out artwork">
            <ShowCover showId={track.showId ?? ''} title={track.showName} size={40} rounded="rounded-control" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{track.title}</p>
              <p className="truncate text-xs text-muted-foreground">{track.showName}</p>
            </div>
          </button>

          <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
            {fmtTime(positionSec)} / {fmtTime(total)}
          </span>

          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={prev} className="size-8 text-muted-foreground hover:text-foreground" aria-label="Previous"><SkipBack className="size-4" /></Button>
            <Button size="icon" onClick={playing ? pause : resume} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current ml-0.5" />}
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={next} className="size-8 text-muted-foreground hover:text-foreground" aria-label="Next"><SkipForward className="size-4" /></Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setSheetOpen(true)} className="size-8 text-muted-foreground hover:text-foreground" aria-label="Open player"><ChevronUp className="size-4" /></Button>
            <Button variant="ghost" size="icon-sm" onClick={close} className="size-8 text-muted-foreground hover:text-foreground" aria-label="Close"><X className="size-3.5" /></Button>
          </div>
        </div>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="h-[88vh] rounded-t-2xl p-0 sm:max-w-none">
          <SheetTitle className="sr-only">Now Playing</SheetTitle>
          <NowPlaying />
        </SheetContent>
      </Sheet>
    </div>
  )
}
