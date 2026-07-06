// Single-track timeline (v1a): custom divs + pointer events (no dnd library; trims
// need continuous pointer capture). Clips render proportionally to their post-speed
// duration; drag the body to scrub-select, drag the edges to trim, use the inspector
// row for reorder/speed/mute/delete.

import { useCallback, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Trash2, Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { useEditor } from '@/components/videostudio/editorStore'
import { clipDurationSec, clipStartSec, edlDurationSec } from '@/components/videostudio/edl'

const PX_PER_SEC_DEFAULT = 12

export function TimelinePanel() {
  const { state, select, setPlayhead, trimClip, removeClip, moveClip, setClipSpeed, toggleMute } = useEditor()
  const { edl, selectedClipId, playheadSec } = state
  const trackRef = useRef<HTMLDivElement>(null)
  const [pxPerSec, setPxPerSec] = useState(PX_PER_SEC_DEFAULT)

  const total = useMemo(() => edlDurationSec(edl), [edl])
  const trackWidth = Math.max(240, total * pxPerSec + 40)
  const selected = edl.video.find((c) => c.id === selectedClipId) ?? null

  const timeAtPointer = useCallback((clientX: number): number => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return Math.max(0, Math.min(total, (clientX - rect.left + el.scrollLeft) / pxPerSec))
  }, [pxPerSec, total])

  // Scrub: pointer down on the ruler/track background moves the playhead and drags.
  const onScrub = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).dataset.clip) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setPlayhead(timeAtPointer(e.clientX))
    const move = (ev: PointerEvent) => setPlayhead(timeAtPointer(ev.clientX))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [setPlayhead, timeAtPointer])

  // Edge trims: pointer-captured drag converts px deltas to SOURCE seconds (× speed).
  const onTrim = useCallback((e: React.PointerEvent, clipId: string, edge: 'in' | 'out') => {
    e.stopPropagation()
    const clip = edl.video.find((c) => c.id === clipId)
    if (!clip) return
    const startX = e.clientX
    const orig = edge === 'in' ? clip.in : clip.out
    const move = (ev: PointerEvent) => {
      const deltaTimeline = (ev.clientX - startX) / pxPerSec
      trimClip(clipId, edge, orig + deltaTimeline * clip.speed)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [edl.video, pxPerSec, trimClip])

  return (
    <div className="flex flex-col gap-2">
      {/* Inspector row for the selected clip. */}
      <div className="flex h-9 items-center gap-1.5">
        {selected ? (
          <>
            <Button size="sm" variant="outline" className="size-7 p-0" title="Move earlier" onClick={() => moveClip(selected.id, -1)}><ArrowLeft className="size-3.5" /></Button>
            <Button size="sm" variant="outline" className="size-7 p-0" title="Move later" onClick={() => moveClip(selected.id, 1)}><ArrowRight className="size-3.5" /></Button>
            <Button size="sm" variant="outline" className="size-7 p-0" title={selected.muted ? 'Unmute' : 'Mute'} onClick={() => toggleMute(selected.id)}>
              {selected.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
            </Button>
            <select
              value={String(selected.speed)}
              onChange={(e) => setClipSpeed(selected.id, parseFloat(e.target.value))}
              className="h-7 rounded-control border border-border bg-background px-1.5 text-xs"
              title="Playback speed"
            >
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((s) => <option key={s} value={s}>{s}x</option>)}
            </select>
            <Button size="sm" variant="outline" className="size-7 p-0 text-destructive" title="Remove clip (⌫)" onClick={() => removeClip(selected.id)}>
              <Trash2 className="size-3.5" />
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Select a clip to trim, reorder, or change speed. Drag clip edges to trim.</span>
        )}
        <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          Zoom
          <input type="range" min={4} max={60} value={pxPerSec} onChange={(e) => setPxPerSec(parseInt(e.target.value, 10))} className="w-24" />
        </div>
      </div>

      {/* Track. */}
      <div
        ref={trackRef}
        className="relative h-24 touch-none overflow-x-auto overflow-y-hidden rounded-card border border-border/60 bg-card/40"
        onPointerDown={onScrub}
      >
        <div className="relative h-full" style={{ width: trackWidth }}>
          {edl.video.map((c, i) => {
            const left = clipStartSec(edl, i) * pxPerSec
            const width = Math.max(10, clipDurationSec(c) * pxPerSec)
            const isSel = c.id === selectedClipId
            return (
              <div
                key={c.id}
                data-clip
                onPointerDown={(e) => { e.stopPropagation(); select(c.id) }}
                className={cn(
                  'absolute top-3 flex h-16 items-center overflow-hidden rounded-control border text-[10px] font-medium',
                  isSel
                    ? 'z-10 border-[var(--yt-accent)] bg-[var(--yt-accent-soft)] text-foreground'
                    : 'border-border bg-accent/60 text-muted-foreground hover:bg-accent',
                )}
                style={{ left, width }}
                title={`${clipDurationSec(c).toFixed(1)}s${c.speed !== 1 ? ` · ${c.speed}x` : ''}${c.muted ? ' · muted' : ''}`}
              >
                <div data-clip className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-foreground/10 hover:bg-foreground/30"
                  onPointerDown={(e) => onTrim(e, c.id, 'in')} />
                <span className="pointer-events-none mx-3 truncate">
                  {i + 1}{c.speed !== 1 ? ` · ${c.speed}x` : ''}{c.muted ? ' · 🔇' : ''}
                </span>
                <div data-clip className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-foreground/10 hover:bg-foreground/30"
                  onPointerDown={(e) => onTrim(e, c.id, 'out')} />
              </div>
            )
          })}
          {/* Playhead. */}
          <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-[var(--yt-accent)]"
            style={{ left: playheadSec * pxPerSec }}>
            <div className="-ml-1 size-2 rounded-full bg-[var(--yt-accent)]" />
          </div>
        </div>
      </div>
    </div>
  )
}
