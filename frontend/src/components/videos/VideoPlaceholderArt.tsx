// Placeholder "art" for video thumbnails: the source's identity gradient with an
// oversized watermark glyph bleeding off the bottom-right (the StationArt pattern).
// Sits at the BOTTOM of every thumbnail stack (under the img) and doubles as the
// no-thumbnail fallback, so grids never show flat bg-muted holes while art loads,
// 404s, or simply doesn't exist. Positioned absolute-inset; parent must be relative.

import { cn } from '@/lib/cn'
import type { VideoSource } from '@/lib/videos/api'
import { MINE_META, SOURCE_META, type SourceMeta } from '@/lib/videos/sources'

export function VideoPlaceholderArt({ source, className }: {
  /** Hub source, or 'mine' for Studio bin content. Unknown/absent falls back to 'link'. */
  source?: VideoSource | 'mine'
  className?: string
}) {
  const meta: SourceMeta = source === 'mine' ? MINE_META : SOURCE_META[source ?? 'link'] ?? SOURCE_META.link
  const Icon = meta.icon
  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
      style={{ background: meta.gradient }}>
      <Icon className="absolute -bottom-[16%] -right-[6%] h-[115%] w-auto text-white/[0.13]" strokeWidth={1.25} />
    </div>
  )
}
