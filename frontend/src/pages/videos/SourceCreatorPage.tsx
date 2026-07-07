import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Plus } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PageContainer } from '@/components/shared/PageContainer'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { ChannelHeader } from '@/components/videos/ChannelHeader'
import { ChannelTabBar } from '@/components/videos/ChannelTabBar'
import { PodcastSourceButtons } from '@/components/youtube/PodcastSourceButtons'
import { HubVideoCollection } from '@/components/videos/HubVideoCollection'
import { InfiniteLoadMore } from '@/components/videos/InfiniteLoadMore'
import { PlaylistCard, PlaylistListRow } from '@/components/videos/PlaylistCard'
import { toast } from '@/lib/toast'
import {
  addFollow, getCreatorPlaylists, getSourceCreator, getVideoSources, listFollows, removeFollow, type VideoSource,
} from '@/lib/videos/api'

type Tab = 'videos' | 'playlists'

/** Creator page for non-YouTube sources (subreddits, TikTok creators, Vimeo channels),
 *  rendered through the same ChannelHeader + ChannelTabBar template as the YouTube channel
 *  page so every subscription page looks identical. */
export function SourceCreatorPage({ source }: { source: VideoSource }) {
  const params = useParams<{ id: string }>()
  const id = params.id ?? ''
  const qc = useQueryClient()
  const [view, setView] = useViewPreference(`videos.${source}_creator_view`, 'grid')
  const [tab, setTab] = useState<Tab>('videos')

  const { data: sourcesData } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources })
  const hasPlaylists = !!sourcesData?.sources.find((s) => s.source === source)?.capabilities.playlists

  const creatorQuery = useInfiniteQuery({
    queryKey: ['videos-creator', source, id],
    queryFn: ({ pageParam }) => getSourceCreator(source, id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.videos.cursor,
    enabled: !!id,
  })
  const creator = creatorQuery.data?.pages[0]?.creator
  const items = useMemo(() => (creatorQuery.data?.pages ?? []).flatMap((p) => p.videos.items), [creatorQuery.data])

  const playlistsQuery = useInfiniteQuery({
    queryKey: ['videos-creator-playlists', source, id],
    queryFn: ({ pageParam }) => getCreatorPlaylists(source, id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor,
    enabled: !!id && tab === 'playlists' && hasPlaylists,
  })
  const playlists = useMemo(() => (playlistsQuery.data?.pages ?? []).flatMap((p) => p.items), [playlistsQuery.data])

  const { data: followsData } = useQuery({ queryKey: ['videos-follows'], queryFn: listFollows })
  const follow = followsData?.follows.find((f) => f.source === source && f.externalId.toLowerCase() === id.toLowerCase())

  const followMutation = useMutation({
    mutationFn: () => (follow ? removeFollow(follow.id) : addFollow(source, id)),
    onSuccess: () => {
      toast.success(follow ? 'Unfollowed' : 'Following')
      void qc.invalidateQueries({ queryKey: ['videos-follows'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not update follow'),
  })

  if (creatorQuery.isLoading) {
    return <PageContainer width="wide" className="flex justify-center py-24"><Spinner /></PageContainer>
  }
  if (creatorQuery.isError || !creator) {
    return (
      <PageContainer width="wide" className="py-12">
        <Card variant="flat" className="p-6 text-sm text-muted-foreground">
          {creatorQuery.error instanceof Error ? creatorQuery.error.message : 'This creator is not available.'}
        </Card>
      </PageContainer>
    )
  }

  const metaLine = [creator.followingText, creator.subscriberText, creator.likesText, creator.handle, creator.videoCount]
    .filter(Boolean).join(' · ')
  const following = !!follow
  const tabs: Array<[Tab, string]> = hasPlaylists ? [['videos', 'Videos'], ['playlists', 'Playlists']] : [['videos', 'Videos']]

  return (
    <PageContainer width="wide" className="py-6">
      <ChannelHeader
        title={creator.name}
        avatarUrl={creator.avatarUrl}
        bannerUrl={creator.bannerUrl}
        metaLine={metaLine}
        description={creator.description}
        actions={<>
          <PodcastSourceButtons
            videos={items.slice(0, 50).map((v) => ({ videoId: v.id, title: v.title, author: v.creator?.name ?? creator.name, source, url: v.url }))}
            sourceId={`${source}:${id}`}
            suggestedShowName={creator.name}
            sourceDescription={creator.description ?? undefined}
            coverImageUrl={creator.avatarUrl ?? undefined}
          />
          <Button size="icon" onClick={() => followMutation.mutate()} disabled={followMutation.isPending}
            aria-label={following ? 'Following. Click to unfollow' : 'Follow'}
            title={following ? 'Following. Click to unfollow' : 'Follow'}
            className={cn('group size-10 disabled:opacity-60',
              following ? 'bg-[var(--yt-accent)] text-white hover:bg-destructive hover:text-white' : 'bg-muted text-muted-foreground hover:bg-muted hover:text-foreground')}>
            {followMutation.isPending ? <Spinner className="text-current" /> : following ? <Check className="size-4" /> : <Plus className="size-4" />}
          </Button>
        </>}
      />

      <ChannelTabBar
        tabs={tabs}
        active={tab}
        onChange={setTab}
        right={<ViewToggle value={view} onChange={setView} className="mb-2 shrink-0" />}
      />

      {tab === 'videos' && (
        items.length === 0 ? (
          <p className="py-20 text-center text-sm text-muted-foreground">No playable videos here right now.</p>
        ) : (
          <>
            <HubVideoCollection items={items} view={view} showSource={false} />
            <InfiniteLoadMore
              hasNextPage={!!creatorQuery.hasNextPage}
              isFetchingNextPage={creatorQuery.isFetchingNextPage}
              fetchNextPage={() => void creatorQuery.fetchNextPage()}
            />
          </>
        )
      )}

      {tab === 'playlists' && (
        playlistsQuery.isLoading ? (
          <div className="flex justify-center py-20"><Spinner /></div>
        ) : playlists.length === 0 ? (
          <p className="py-20 text-center text-sm text-muted-foreground">No playlists here right now.</p>
        ) : view === 'list' ? (
          <div className="space-y-1">
            {playlists.map((p) => (
              <PlaylistListRow key={p.id} source={source}
                p={{ playlistId: p.id, title: p.title, videoCount: p.videoCount ?? null, thumbnailUrl: p.thumbnailUrl ?? null, author: creator.name }} />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4">
              {playlists.map((p) => (
                <PlaylistCard key={p.id} source={source}
                  p={{ playlistId: p.id, title: p.title, videoCount: p.videoCount ?? null, thumbnailUrl: p.thumbnailUrl ?? null, author: creator.name }} />
              ))}
            </div>
            <InfiniteLoadMore
              hasNextPage={!!playlistsQuery.hasNextPage}
              isFetchingNextPage={playlistsQuery.isFetchingNextPage}
              fetchNextPage={() => void playlistsQuery.fetchNextPage()}
            />
          </>
        )
      )}
    </PageContainer>
  )
}
