import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Plus, UserRound } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { addFollow, browseSource, getFollowingFeed, listFollows } from '@/lib/videos/api'
import { SOURCE_META } from '@/lib/videos/sources'
import { HubVideoCard } from '@/components/videos/HubVideoCard'

// TikTok has no browsable trending here (scrape-only, flaky), so this page is the
// followed-creators feed: follow @handles and their latest videos accumulate via the
// background poller. Individual links always work through Clip a Link.
export function TikTokBrowsePage() {
  const qc = useQueryClient()
  const [activeCreator, setActiveCreator] = useState<string | null>(null)
  const [handleInput, setHandleInput] = useState('')

  const { data: followsData } = useQuery({ queryKey: ['videos-follows'], queryFn: listFollows })
  const creators = useMemo(() => (followsData?.follows ?? []).filter((f) => f.source === 'tiktok'), [followsData])

  const { data: feedData, isLoading } = useQuery({
    queryKey: ['videos-following-feed', 'tiktok'],
    queryFn: () => getFollowingFeed('tiktok'),
    enabled: creators.length > 0,
  })

  // Zero-setup surface: popular creators' latest videos (cold load takes a few seconds
  // while yt-dlp extracts the first profiles; cached ten minutes after that).
  const popularQuery = useQuery({
    queryKey: ['tiktok-popular'],
    queryFn: () => browseSource('tiktok'),
    enabled: creators.length === 0,
    staleTime: 5 * 60_000,
  })
  const items = useMemo(() => {
    const all = feedData?.items ?? []
    if (!activeCreator) return all
    return all.filter((it) => it.creator?.id === activeCreator)
  }, [feedData, activeCreator])

  const followMutation = useMutation({
    mutationFn: (handle: string) => addFollow('tiktok', handle),
    onSuccess: () => {
      setHandleInput('')
      toast.success('Following')
      void qc.invalidateQueries({ queryKey: ['videos-follows'] })
      void qc.invalidateQueries({ queryKey: ['videos-following-feed', 'tiktok'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not follow that creator'),
  })

  return (
    <PageContainer width="wide" className="pt-1 pb-8">
      <PageHeader
        title={SOURCE_META.tiktok.label}
        icon={SOURCE_META.tiktok.icon}
        gradient={SOURCE_META.tiktok.gradient}
        subtitle={creators.length > 0 ? 'Latest from the creators you follow.' : 'Popular right now. Follow creators to make this feed yours.'}
        className="pt-4 pb-4"
        actions={
          <form
            className="flex shrink-0 gap-2"
            onSubmit={(e) => { e.preventDefault(); const h = handleInput.trim().replace(/^@/, ''); if (h) followMutation.mutate(h) }}
          >
            <Input value={handleInput} onChange={(e) => setHandleInput(e.target.value)}
              placeholder="Follow @creator…" className="h-9 w-44" autoComplete="off" />
            <Button type="submit" size="sm" variant="outline" className="gap-1" disabled={!handleInput.trim() || followMutation.isPending}>
              <Plus className="size-4" /> Follow
            </Button>
          </form>
        }
      />

      {creators.length > 0 && (
        <ChipRow className="mb-5 min-w-0">
          <Chip label="All" active={activeCreator === null} onClick={() => setActiveCreator(null)} />
          {creators.map((f) => (
            <Chip key={f.id} label={f.title} active={activeCreator === f.externalId}
              onClick={() => setActiveCreator(activeCreator === f.externalId ? null : f.externalId)} />
          ))}
        </ChipRow>
      )}

      {creators.length === 0 ? (
        popularQuery.isLoading ? (
          <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
            <SkeletonCards count={12} className="w-full md:grid-cols-4 xl:grid-cols-6" />
            <p className="text-xs">Fetching popular creators, this takes a few seconds the first time…</p>
          </div>
        ) : (popularQuery.data?.items.length ?? 0) > 0 ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {popularQuery.data!.items.map((it) => <HubVideoCard key={`${it.source}:${it.id}`} item={it} showSource={false} />)}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground">
            <UserRound className="mb-3 size-10 opacity-30" />
            <p className="text-sm font-medium">Follow a TikTok creator to build your feed</p>
            <p className="mt-1 max-w-sm text-xs">
              Add an @handle above, or paste any TikTok link into{' '}
              <Link to="/videos/clip" className="inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-2">
                <Link2 className="size-3" /> Clip a Link
              </Link>{' '}
              to watch or save it.
            </p>
          </div>
        )
      ) : isLoading ? (
        <SkeletonCards count={12} className="xl:grid-cols-4" />
      ) : items.length === 0 ? (
        <p className="py-20 text-center text-sm text-muted-foreground">
          Nothing here yet. New uploads appear within about 15 minutes of following.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {items.map((it) => <HubVideoCard key={`${it.source}:${it.id}`} item={it} showSource={false} />)}
        </div>
      )}
    </PageContainer>
  )
}
