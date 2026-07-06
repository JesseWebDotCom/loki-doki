import { cn } from '@/lib/cn'
import { SOURCE_META } from '@/lib/videos/sources'
import type { VideoSource } from '@/lib/videos/api'

/** Source filter pill with the source's brand dot (shape matches shared Chip). */
export function SourceChip({ source, active, onClick }: {
  source: VideoSource
  active?: boolean
  onClick?: () => void
}) {
  const meta = SOURCE_META[source]
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors',
        active
          ? meta.pillActiveClass
          : 'bg-foreground/8 text-muted-foreground hover:bg-foreground/12 hover:text-foreground',
      )}
    >
      <meta.icon className="size-3.5" aria-hidden />
      {meta.label}
    </button>
  )
}
