import { cn } from '@/lib/cn'
import { MINE_META, SOURCE_META, type SourceMeta } from '@/lib/videos/sources'
import type { VideoSource } from '@/lib/videos/api'

function chipClass(active: boolean | undefined, meta: SourceMeta) {
  return cn(
    'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors',
    active
      ? meta.pillActiveClass
      : 'bg-foreground/8 text-muted-foreground hover:bg-foreground/12 hover:text-foreground',
  )
}

/** Source filter pill with the source's brand dot (shape matches shared Chip). */
export function SourceChip({ source, active, onClick }: {
  source: VideoSource
  active?: boolean
  onClick?: () => void
}) {
  const meta = SOURCE_META[source]
  return (
    <button type="button" onClick={onClick} className={chipClass(active, meta)}>
      <meta.icon className="size-3.5" aria-hidden />
      {meta.label}
    </button>
  )
}

/** "Mine" filter pill — your Studio bin content (exports/uploads/recordings/AI clips), not
 *  a real VideoSource, so it's a separate component rather than another SourceChip variant. */
export function MineChip({ active, onClick }: { active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className={chipClass(active, MINE_META)}>
      <MINE_META.icon className="size-3.5" aria-hidden />
      {MINE_META.label}
    </button>
  )
}
