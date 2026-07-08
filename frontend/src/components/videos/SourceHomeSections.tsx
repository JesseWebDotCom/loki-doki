import { SectionHeader } from '@/components/shared/SectionHeader'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { HubMediaShelf } from '@/components/videos/HubMediaShelf'
import { HubCreatorRail, type HubCreatorEntry } from '@/components/videos/HubCreatorRail'
import { HubVideoCollection } from '@/components/videos/HubVideoCollection'
import { SourceDiscovery } from '@/components/videos/SourceDiscovery'
import type { CardListView } from '@/components/shared/ViewToggle'
import type { HubVideoItem, VideoSource } from '@/lib/videos/api'

/** The fixed-order "home" dashboard shared by every non-YouTube source's own page
 *  (TikTok/Vimeo/Reddit), matching YoutubeHomePage's own default layout section-for-
 *  section: Popular, Trending, Continue watching, Your subscriptions, then Latest from
 *  your subscriptions. A source with nothing for a given section (e.g. Vimeo has no
 *  follow system yet, so no subscriptions/latest) just skips it — same as YouTube's own
 *  page, which hides Recommended/Shorts/Latest when they'd be empty. */
export function SourceHomeSections({
  source, view, discovery, continueWatching, creators, latestItems, latestLoading,
}: {
  source: VideoSource
  view: CardListView
  discovery: Array<'popular' | 'trending'>
  continueWatching: HubVideoItem[]
  creators: HubCreatorEntry[]
  latestItems: HubVideoItem[]
  latestLoading?: boolean
}) {
  return (
    <div className="space-y-10">
      <SourceDiscovery source={source} discovery={discovery} view={view} />
      {continueWatching.length > 0 && <HubMediaShelf title="Continue watching" items={continueWatching} view={view} showSource={false} />}
      {creators.length > 0 && <HubCreatorRail title="Your subscriptions" source={source} creators={creators} />}
      {latestLoading ? (
        <SkeletonCards count={12} className="xl:grid-cols-4" />
      ) : latestItems.length > 0 ? (
        <section>
          <SectionHeader title="Latest from your subscriptions" className="mb-4" />
          <HubVideoCollection items={latestItems} view={view} showSource={false} />
        </section>
      ) : null}
    </div>
  )
}
