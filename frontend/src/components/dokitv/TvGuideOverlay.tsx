// In-player guide overlay: every channel with its current and next program; click to tune.
// Kept intentionally lighter than the full-page guide grid (this is the remote-control
// flip-through surface).

import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { fetchTvGuide, tvClock, tvGlyph } from '@/lib/dokitv/api'

interface TvGuideOverlayProps {
  open: boolean
  activeSlug: string
  onClose: () => void
  onTune: (slug: string) => void
}

export function TvGuideOverlay({ open, activeSlug, onClose, onTune }: TvGuideOverlayProps) {
  const { data } = useQuery({
    queryKey: ['tv-guide-overlay'],
    queryFn: () => fetchTvGuide(3),
    refetchInterval: 60_000,
    enabled: open,
  })

  if (!open) return null
  const now = Date.now()

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-black/85 backdrop-blur-sm max-md:bottom-[var(--bottom-chrome,0px)]">
      <div className="flex items-center justify-between px-5 py-4">
        <h2 className="text-lg font-bold text-white">Guide</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close guide"
          className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
        >
          <X className="size-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
          {(data?.channels ?? []).map((ch) => {
            const current = ch.blocks.find((b) => b.startAt <= now && b.endAt > now)
            const next = ch.blocks.find((b) => b.startAt > now)
            const Glyph = tvGlyph(ch.glyph)
            return (
              <button
                key={ch.id}
                type="button"
                onClick={() => { onTune(ch.slug); onClose() }}
                // design-ok(glass-on-plain-bg): guide rows float over the live TV picture
                className={cn(
                  'flex w-full items-center gap-3 rounded-card border px-3 py-2.5 text-left transition-colors',
                  ch.slug === activeSlug
                    ? 'border-white/30 bg-white/15'
                    : 'border-transparent bg-white/5 hover:bg-white/10',
                )}
              >
                <div
                  className="flex size-11 shrink-0 flex-col items-center justify-center rounded-control text-white"
                  style={{ background: `linear-gradient(135deg, ${ch.color}, ${ch.colorDark})` }}
                >
                  <Glyph className="size-4" />
                  <span className="text-[10px] font-extrabold tabular-nums">{ch.number}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-white">{ch.name}</p>
                  <p className="truncate text-xs text-white/60">{current?.title ?? 'Off the air'}</p>
                </div>
                {next ? (
                  <div className="hidden shrink-0 text-right sm:block">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
                      {tvClock(next.startAt)}
                    </p>
                    <p className="max-w-36 truncate text-xs text-white/60">{next.title}</p>
                  </div>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
