import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Plus } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { InfiniteLoadMore } from '@/components/videos/InfiniteLoadMore'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import { addFollow, getSourceCreator, listFollows, removeFollow, type VideoSource } from '@/lib/videos/api'
import { HubVideoCollection } from '@/components/videos/HubVideoCollection'

/** Creator page for non-YouTube sources (subreddits, TikTok creators, Vimeo channels).
 *  YouTube channels keep their richer native page. */
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

  return (
    <PageContainer width="wide" className="py-6">
      {creator.bannerUrl && (
        <div className="mb-5 h-32 w-full overflow-hidden rounded-card bg-muted sm:h-44">
          <img src={proxyImg(creator.bannerUrl)} alt="" className="size-full object-cover" />
        </div>
      )}
      <div className="mb-8 flex items-center gap-4">
        {creator.avatarUrl && (
          <img src={proxyImg(creator.avatarUrl)} alt="" className="size-16 rounded-full object-cover ring-1 ring-border/40" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xl font-bold">{creator.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {[creator.subscriberText, creator.handle].filter(Boolean).join(' · ')}
          </p>
          {creator.description && <p className="mt-1 line-clamp-2 max-w-2xl text-sm text-muted-foreground">{creator.description}</p>}
        </div>
        <Button
          variant={follow ? 'secondary' : 'default'}
          className="shrink-0 gap-1.5"
          disabled={followMutation.isPending}
          onClick={() => followMutation.mutate()}
        >
          {follow ? <Check className="size-4" /> : <Plus className="size-4" />}
          {follow ? 'Following' : 'Follow'}
        </Button>
      </div>

      {items.length === 0 ? (
        <p className="py-20 text-center text-sm text-muted-foreground">No playable videos here right now.</p>
      ) : (
        <>
          <div className="mb-4 flex justify-end">
            <ViewToggle value={view} onChange={setView} className="shrink-0" />
          </div>
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
