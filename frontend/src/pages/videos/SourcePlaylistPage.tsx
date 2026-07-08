import { useMemo } from 'react'
import { useParams, useLocation } from 'react-router-dom'
import { useInfiniteQuery } from '@tanstack/react-query'
import { ListVideo } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { Spinner } from '@/components/ui/spinner'
import { proxyImg } from '@/lib/img'
import { HubVideoCollection } from '@/components/videos/HubVideoCollection'
import { InfiniteLoadMore } from '@/components/videos/InfiniteLoadMore'
import { getSourcePlaylist, type VideoSource } from '@/lib/videos/api'

/** Playlist detail page for non-YouTube sources (TikTok "playlists" tab, etc). YouTube
 *  keeps its own richer playlist page. Playlist metadata (title/cover) isn't refetched here —
 *  it comes from router state set by the PlaylistCard that linked here, same pattern as
 *  YoutubePlaylistPage. */
export function SourcePlaylistPage({ source }: { source: VideoSource }) {
  const params = useParams<{ id: string }>()
  const id = params.id ?? ''
  const navState = (useLocation().state ?? {}) as { title?: string; thumbnailUrl?: string | null; videoCount?: number | null }
  const [view, setView] = useViewPreference(`videos.${source}_playlist_view`, 'grid')

  const query = useInfiniteQuery({
    queryKey: ['videos-playlist', source, id],
    queryFn: ({ pageParam }) => getSourcePlaylist(source, id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor,
    enabled: !!id,
  })
  const items = useMemo(() => (query.data?.pages ?? []).flatMap((p) => p.items), [query.data])
  const title = navState.title || 'Playlist'
  const videoCount = navState.videoCount ?? (query.isLoading ? null : items.length)

  return (
    <PageContainer width="wide" className="py-6">
      <div className="mb-8 flex items-start gap-4">
        <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-card bg-muted ring-1 ring-border/40 sm:w-36">
          {navState.thumbnailUrl
            ? <img src={proxyImg(navState.thumbnailUrl)} alt="" className="size-full object-cover" />
            : <div className="flex size-full items-center justify-center"><ListVideo className="size-8 text-muted-foreground/40" /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-overline text-muted-foreground/60">Playlist</p>
          {/* design-ok(raw-h1-in-pages): playlist identity header (content title, not app chrome) */}
          <h1 className="truncate text-display">{title}</h1>
          {videoCount != null && <p className="text-sm text-muted-foreground">{videoCount} {videoCount === 1 ? 'video' : 'videos'}</p>}
        </div>
      </div>

      {query.isLoading ? (
        <div className="flex justify-center py-24"><Spinner /></div>
      ) : items.length === 0 ? (
        <p className="py-20 text-center text-sm text-muted-foreground">This playlist has no playable videos, or it couldn't be loaded.</p>
      ) : (
        <>
          <div className="mb-4 flex justify-end">
            <ViewToggle value={view} onChange={setView} className="shrink-0" />
          </div>
          <HubVideoCollection items={items} view={view} showSource={false} />
          <InfiniteLoadMore
            hasNextPage={!!query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            fetchNextPage={() => void query.fetchNextPage()}
          />
        </>
      )}
    </PageContainer>
  )
}
