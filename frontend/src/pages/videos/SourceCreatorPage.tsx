import { useMemo } from 'react'
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
import { HubVideoCollection } from '@/components/videos/HubVideoCollection'
import { InfiniteLoadMore } from '@/components/videos/InfiniteLoadMore'
import { toast } from '@/lib/toast'
import { addFollow, getSourceCreator, listFollows, removeFollow, type VideoSource } from '@/lib/videos/api'

/** Creator page for non-YouTube sources (subreddits, TikTok creators, Vimeo channels),
 *  rendered through the same ChannelHeader + ChannelTabBar template as the YouTube channel
 *  page so every subscription page looks identical. */
export function SourceCreatorPage({ source }: { source: VideoSource }) {
  const params = useParams<{ id: string }>()
  const id = params.id ?? ''
  const qc = useQueryClient()
  const [view, setView] = useViewPreference(`videos.${source}_creator_view`, 'grid')

  const creatorQuery = useInfiniteQuery({
    queryKey: ['videos-creator', source, id],
    queryFn: ({ pageParam }) => getSourceCreator(source, id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.videos.cursor,
    enabled: !!id,
  })
  const creator = creatorQuery.data?.pages[0]?.creator
  const items = useMemo(() => (creatorQuery.data?.pages ?? []).flatMap((p) => p.videos.items), [creatorQuery.data])

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

  const metaLine = [creator.subscriberText, creator.handle, creator.videoCount].filter(Boolean).join(' · ')
  const following = !!follow

  return (
    <PageContainer width="wide" className="py-6">
      <ChannelHeader
        title={creator.name}
        avatarUrl={creator.avatarUrl}
        bannerUrl={creator.bannerUrl}
        metaLine={metaLine}
        description={creator.description}
        actions={
          <Button size="icon" onClick={() => followMutation.mutate()} disabled={followMutation.isPending}
            aria-label={following ? 'Following. Click to unfollow' : 'Follow'}
            title={following ? 'Following. Click to unfollow' : 'Follow'}
            className={cn('group size-10 disabled:opacity-60',
              following ? 'bg-[var(--yt-accent)] text-white hover:bg-destructive hover:text-white' : 'bg-muted text-muted-foreground hover:bg-muted hover:text-foreground')}>
            {followMutation.isPending ? <Spinner className="text-current" /> : following ? <Check className="size-4" /> : <Plus className="size-4" />}
          </Button>
        }
      />

      <ChannelTabBar
        tabs={[['videos', 'Videos']]}
        active="videos"
        onChange={() => {}}
        right={<ViewToggle value={view} onChange={setView} className="mb-2 shrink-0" />}
      />

      {items.length === 0 ? (
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
      )}
    </PageContainer>
  )
}
