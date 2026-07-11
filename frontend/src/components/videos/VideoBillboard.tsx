// The hub home's focal point: a full-width editorial billboard for one featured video,
// the same Apple-Music/Netflix pattern as Music's StationBillboard. The video's thumbnail
// anchors the right edge and DISSOLVES into an accent extracted from the art itself
// (this is one of the three sanctioned dynamic-palette surfaces: watch page, channel
// pages, home billboard). Clicking anywhere opens the watch page.

import { Link } from 'react-router-dom'
import { Play } from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { thumbUrl } from '@/lib/youtube/format'
import { ytImageProxy } from '@/lib/youtube/api'
import { accentOf, useArtPalette } from '@/lib/artPalette'
import { BlendedHeroBackdrop } from '@/components/shared/BlendedHeroBackdrop'
import { SOURCE_META } from '@/lib/videos/sources'
import { HUB_PATHS } from '@/components/videos/HubVideoCard'
import { VideoPlaceholderArt } from '@/components/videos/VideoPlaceholderArt'
import type { HubVideoItem } from '@/lib/videos/api'

/** Billboard art: YouTube gets the sharper hqdefault straight from the yt image cache
 *  (mq looks soft at billboard size; maxres has no onError path here so we don't chase it);
 *  other sources proxy whatever thumbnail the provider gave us. Same-origin either way,
 *  so the palette extraction below never taints the canvas. */
function billboardArt(item: HubVideoItem): string | null {
  if (item.source === 'youtube') return ytImageProxy(thumbUrl(item.id, 'hq'))
  return item.thumbnailUrl ? proxyImg(item.thumbnailUrl) : null
}

export function VideoBillboard({ item, eyebrow, resume }: {
  item: HubVideoItem
  /** Editorial label, e.g. "Featured today" or "Continue watching". */
  eyebrow: string
  /** Renders the pill as "Resume" (the watch page picks up the saved position). */
  resume?: boolean
}) {
  const art = billboardArt(item)
  const palette = useArtPalette(art)
  const accent = accentOf(palette)
  const badge = SOURCE_META[item.source]
  const meta = [item.creator?.name, item.viewsText].filter(Boolean).join(' · ')

  return (
    <Link to={HUB_PATHS[item.source].watch(item.id)}
      className="group relative mb-8 block w-full overflow-hidden rounded-sheet text-left shadow-xl">
      <div className="relative aspect-[2/1] w-full overflow-hidden sm:aspect-[21/6]">
        <BlendedHeroBackdrop art={art} color={accent} colorDark={palette.dark}
          fallback={<VideoPlaceholderArt source={item.source} />} />
      </div>
      <div className="absolute inset-y-0 left-0 flex max-w-xl flex-col justify-center gap-2 p-6 sm:p-9">
        <span className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-white/60">{eyebrow}</span>
          <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold', badge.badgeClass)}>
            <badge.icon className="size-2.5" aria-hidden /> {badge.label}
          </span>
        </span>
        <span className="line-clamp-2 text-xl font-extrabold tracking-tight text-white sm:text-4xl">{item.title}</span>
        {meta && <span className="line-clamp-1 max-w-md text-sm text-white/70">{meta}</span>}
        <span className="mt-2 inline-flex w-fit items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition group-hover:scale-105 group-active:scale-95">
          <Play className="size-4 fill-current" /> {resume ? 'Resume' : 'Play'}
        </span>
      </div>
    </Link>
  )
}
