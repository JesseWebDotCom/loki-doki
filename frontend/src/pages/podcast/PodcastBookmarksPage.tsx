import { useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { BookmarkRow } from '@/components/podcast/BookmarkRow'
import { getBookmarks, type PodcastBookmark } from '@/lib/podcast/playerApi'
import { getAppByPath } from '@/lib/appCategories'

/** All of this user's podcast bookmarks, grouped by show. Tap one to resume the episode
 *  at that exact moment. */
export function PodcastBookmarksPage() {
  const qc = useQueryClient()
  const { data: bookmarks = [], isLoading } = useQuery({
    queryKey: ['podcast-bookmarks'],
    queryFn: () => getBookmarks(),
  })

  const byShow = useMemo(() => {
    const groups = new Map<string, { showName: string; items: PodcastBookmark[] }>()
    for (const b of bookmarks) {
      const g = groups.get(b.showId) ?? { showName: b.showName, items: [] }
      g.items.push(b)
      groups.set(b.showId, g)
    }
    return [...groups.entries()]
  }, [bookmarks])

  const refresh = () => void qc.invalidateQueries({ queryKey: ['podcast-bookmarks'] })

  return (
    <PageContainer width="narrow" className="py-2 pb-24">
      <PageHeader title="Bookmarks" subtitle="Moments you saved while listening. Tap one to jump right back." />

      {isLoading ? null : bookmarks.length === 0 ? (
        <EmptyAppState
          icon={Bookmark}
          gradient={getAppByPath('/podcasts')?.gradient}
          title="No bookmarks yet"
          tagline="While an episode plays, tap the bookmark button in the player to save the moment. Everything you save lands here."
        />
      ) : (
        <div className="space-y-8">
          {byShow.map(([showId, group]) => (
            <section key={showId}>
              <SectionHeader title={group.showName} to={`/podcasts/show/${showId}`} className="mb-2" />
              <div className="space-y-0.5">
                {group.items.map(b => (
                  <BookmarkRow key={b.id} bookmark={b} onChanged={refresh} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageContainer>
  )
}
