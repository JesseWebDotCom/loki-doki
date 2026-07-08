import { cn } from '@/lib/cn'
import { MINE_META } from '@/lib/videos/sources'
import { studioStreamUrl, type StudioBinItem } from '@/lib/videos/studioApi'

function fmtMineDur(sec: number | null): string | null {
  if (sec == null || sec <= 0) return null
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

const mineBadge = (
  <span className={cn('absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', MINE_META.badgeClass)}>
    <MINE_META.icon className="size-2.5" aria-hidden /> {MINE_META.label}
  </span>
)

/** Studio bin card for mixed feeds (Home, Offline, History) — bin items have no dedicated
 *  watch page (they're not hub provider content), so it opens the raw file directly, same
 *  as a Clip a Link card. */
export function MineCard({ item, shape }: { item: StudioBinItem; shape?: 'wide' | 'tall' }) {
  const dur = fmtMineDur(item.durationSec)
  return (
    <a href={studioStreamUrl(item.assetId)} target="_blank" rel="noreferrer noopener" className="group flex flex-col gap-2.5">
      <div className={cn('relative w-full overflow-hidden rounded-card bg-muted', shape === 'tall' ? 'aspect-[9/16]' : 'aspect-video')}>
        {item.thumbUrl ? (
          <img src={item.thumbUrl} alt="" loading="lazy" className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" />
        ) : (
          <div className="flex size-full items-center justify-center"><MINE_META.icon className="size-8 text-muted-foreground/50" /></div>
        )}
        {mineBadge}
        {dur && <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{dur}</span>}
      </div>
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">{item.title}</p>
        <p className="mt-1 truncate text-xs capitalize text-muted-foreground">{item.origin}</p>
      </div>
    </a>
  )
}

/** List-row counterpart of MineCard. */
export function MineRow({ item }: { item: StudioBinItem }) {
  const dur = fmtMineDur(item.durationSec)
  return (
    <a href={studioStreamUrl(item.assetId)} target="_blank" rel="noreferrer noopener"
      className="group flex gap-3 rounded-card p-1.5 transition-colors hover:bg-accent/50 sm:gap-4">
      <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-card bg-muted sm:w-56">
        {item.thumbUrl ? (
          <img src={item.thumbUrl} alt="" loading="lazy" className="size-full object-cover transition group-hover:scale-105" />
        ) : (
          <div className="flex size-full items-center justify-center"><MINE_META.icon className="size-8 text-muted-foreground/40" /></div>
        )}
        {mineBadge}
        {dur && <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/80 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">{dur}</span>}
      </div>
      <div className="min-w-0 flex-1 py-0.5">
        <p className="line-clamp-2 text-sm font-semibold leading-snug sm:text-[15px]">{item.title}</p>
        <p className="mt-1 truncate text-xs capitalize text-muted-foreground">{item.origin}</p>
      </div>
    </a>
  )
}
