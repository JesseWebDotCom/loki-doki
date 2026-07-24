// Transient channel info banner (the "you changed channels" lower third): number, name,
// program title, progress through the block, and what is next. Parent controls visibility.

import { cn } from '@/lib/cn'
import { tvClock, tvGlyph, type TvNow } from '@/lib/dokitv/api'

interface TvInfoBannerProps {
  now: TvNow
  visible: boolean
}

export function TvInfoBanner({ now, visible }: TvInfoBannerProps) {
  const { channel, block, next } = now
  const Glyph = tvGlyph(channel.glyph)
  const progress = block ? Math.min(1, Math.max(0, (Date.now() - block.startAt) / (block.endAt - block.startAt))) : 0

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 z-20 p-4 pb-[max(1rem,calc(var(--bottom-chrome,0px)+0.5rem))] transition-all duration-300 sm:p-6',
        visible ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0',
      )}
    >
      <div className="mx-auto flex max-w-3xl items-center gap-4 rounded-card border border-white/10 bg-black/75 p-4 backdrop-blur-md">
        <div
          className="flex size-14 shrink-0 flex-col items-center justify-center rounded-card text-white"
          style={{ background: `linear-gradient(135deg, ${channel.color}, ${channel.colorDark})` }}
        >
          <Glyph className="size-5" />
          <span className="text-xs font-extrabold tabular-nums">{channel.number}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold uppercase tracking-widest text-white/50">{channel.name}</p>
          <p className="truncate text-lg font-bold text-white">{block?.title ?? 'Off the air'}</p>
          {block?.subtitle ? <p className="truncate text-sm text-white/60">{block.subtitle}</p> : null}
          {block ? (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs tabular-nums text-white/50">{tvClock(block.startAt)}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/15">
                <div className="h-full rounded-full bg-white/80" style={{ width: `${progress * 100}%` }} />
              </div>
              <span className="text-xs tabular-nums text-white/50">{tvClock(block.endAt)}</span>
            </div>
          ) : null}
        </div>
        {next[0] ? (
          <div className="hidden max-w-40 shrink-0 text-right sm:block">
            <p className="text-xs font-semibold uppercase tracking-widest text-white/40">Next</p>
            <p className="truncate text-sm font-semibold text-white/80">{next[0].title}</p>
            <p className="text-xs tabular-nums text-white/50">{tvClock(next[0].startAt)}</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
