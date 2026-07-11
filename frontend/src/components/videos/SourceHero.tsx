// Source dashboard identity hero: replaces the small PageHeader tile with a compact
// BlendedHeroBackdrop strip in the source's STATIC brand colors (dynamic palette
// extraction stays reserved for the watch page / channel pages / home billboard).
// Optional artwork = a current popular thumbnail, so the strip feels alive without
// costing an extra request (the query is shared with the page's own discovery shelves).

import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { proxyImgAuto } from '@/lib/img'
import { BlendedHeroBackdrop } from '@/components/shared/BlendedHeroBackdrop'
import { SOURCE_META } from '@/lib/videos/sources'
import { browseSource, type VideoSource } from '@/lib/videos/api'

/** First available thumbnail of the source's discovery feed (cache-shared with the
 *  page's shelves; pass `feed: null` to skip fetching, e.g. offline or unconfigured). */
export function useSourceHeroArt(source: VideoSource, feed: 'popular' | 'trending' | null): string | null {
  const { data } = useQuery({
    queryKey: ['videos-discover', source, feed],
    queryFn: () => browseSource(source, { feed: feed ?? undefined }),
    staleTime: 10 * 60_000,
    enabled: feed != null,
  })
  const thumb = data?.items.find((i) => i.thumbnailUrl)?.thumbnailUrl
  return thumb ? proxyImgAuto(thumb) : null
}

export function SourceHero({ source, subtitle, actions, artUrl }: {
  source: VideoSource
  subtitle?: string
  actions?: ReactNode
  artUrl?: string | null
}) {
  const meta = SOURCE_META[source]
  return (
    <div className="relative mb-6 overflow-hidden rounded-sheet shadow-xl">
      <BlendedHeroBackdrop art={artUrl ?? null} color={meta.heroColor} colorDark={meta.heroColorDark} />
      <div className="relative flex min-h-32 flex-wrap items-center gap-x-4 gap-y-3 p-5 sm:min-h-40 sm:p-7">
        <div className="grid size-11 shrink-0 place-items-center rounded-card text-white shadow-lg sm:size-12" style={{ background: meta.gradient }}>
          <meta.icon className="size-5 sm:size-6" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{meta.label}</span>
          {subtitle && <span className="mt-0.5 block max-w-xl text-sm text-white/70">{subtitle}</span>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
