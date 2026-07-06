import { useState } from 'react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { HScroll } from '@/components/youtube/shelves'
import { HUB_PATHS } from '@/components/videos/HubVideoCard'
import type { VideoSource } from '@/lib/videos/api'

// design-ok(raw-palette-semantic): deterministic letter-avatar palette (identity data, not a UI accent)
const AVATAR_COLORS = ['bg-red-500/20 text-red-400', 'bg-blue-500/20 text-blue-400', 'bg-green-500/20 text-green-400',
  'bg-sky-500/20 text-sky-400', 'bg-brand/15 text-brand', 'bg-pink-500/20 text-pink-400',
  'bg-teal-500/20 text-teal-400', 'bg-orange-500/20 text-orange-400']

/** Generic creator/community avatar (image with a deterministic-letter fallback), mirroring
 *  youtube's ChannelAvatar but routed through the SSRF-safe generic image proxy instead of
 *  YouTube's own: Reddit/TikTok/Vimeo avatars don't live on YouTube's CDN. */
function CreatorAvatar({ title, src, className }: { title: string; src?: string | null; className?: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (src && failedSrc !== src) {
    return <img key={src} src={proxyImg(src)} alt={title} className={cn('rounded-full object-cover shrink-0', className)} onError={() => setFailedSrc(src)} />
  }
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length]
  const letter = (title.trim()[0] ?? '?').toUpperCase()
  return <div className={cn('flex items-center justify-center rounded-full font-semibold shrink-0', color, className)}>{letter}</div>
}

export interface HubCreatorEntry {
  id: string
  title: string
  thumbnailUrl: string | null
}

/** Followed-creator avatar scroller: the source-agnostic counterpart to youtube's
 *  ChannelRail (subscriptions), used for Reddit's followed subreddits and TikTok's
 *  followed creators. */
export function HubCreatorRail({ title, source, creators }: { title: string; source: VideoSource; creators: HubCreatorEntry[] }) {
  if (!creators.length) return null
  return (
    <section>
      <SectionHeader title={title} className="mb-4" />
      <HScroll>
        {creators.map((c) => (
          <Link key={c.id} to={HUB_PATHS[source].creator(c.id)}
            className="group flex w-28 shrink-0 flex-col items-center gap-2 text-center">
            <CreatorAvatar title={c.title} src={c.thumbnailUrl} className="size-20 text-2xl ring-1 ring-border/40 transition group-hover:ring-2 group-hover:ring-[var(--yt-accent)]" />
            <p className="line-clamp-1 w-full text-sm font-semibold">{c.title}</p>
          </Link>
        ))}
      </HScroll>
    </section>
  )
}
