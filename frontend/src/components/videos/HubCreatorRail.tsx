import { Link } from 'react-router-dom'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { HScroll } from '@/components/youtube/shelves'
import { CreatorAvatar } from '@/components/videos/CreatorAvatar'
import { HUB_PATHS } from '@/components/videos/HubVideoCard'
import type { VideoSource } from '@/lib/videos/api'

export { CreatorAvatar }

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
