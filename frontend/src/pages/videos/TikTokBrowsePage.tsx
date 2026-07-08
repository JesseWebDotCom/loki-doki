import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Plus, UserRound } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/lib/toast'
import { addFollow, browseSource, getFollowingFeed, getVideoSources, listFollows } from '@/lib/videos/api'
import { useSourceContinueWatching } from '@/lib/videos/useSourceContinueWatching'
import { SOURCE_META } from '@/lib/videos/sources'
import { HubVideoCollection } from '@/components/videos/HubVideoCollection'
import { SourceHomeSections } from '@/components/videos/SourceHomeSections'
import { SourceExploreGrid } from '@/components/videos/SourceExploreGrid'
import { SourceDisabledCard } from '@/components/videos/SourceDisabledCard'

// TikTok has no browsable trending here (scrape-only, flaky), so this page defaults to
// popular starter creators until you follow your own; follows accumulate via the
// background poller. Individual links always work through Clip a Link.
export function TikTokBrowsePage() {
  const qc = useQueryClient()
  const [activeCreator, setActiveCreator] = useState<string | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [handleInput, setHandleInput] = useState('')
  const [view, setView] = useViewPreference('videos.tiktok_view', 'grid')
  const { data: sourcesData } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources })
  const tiktokSource = sourcesData?.sources.find((s) => s.source === 'tiktok')
  const categories = tiktokSource?.browseFeeds ?? []
  const enabled = tiktokSource?.enabled ?? true

  const { data: followsData } = useQuery({ queryKey: ['videos-follows'], queryFn: listFollows })
  const creators = useMemo(() => (followsData?.follows ?? []).filter((f) => f.source === 'tiktok'), [followsData])
  const creatorEntries = useMemo(() => creators.map((c) => ({ id: c.externalId, title: c.title, thumbnailUrl: c.thumbnailUrl ?? null })), [creators])

  const continueWatching = useSourceContinueWatching('tiktok', enabled)

  // Dashboard = nothing selected (the default landing view); a category or a specific
  // followed creator swaps in the flat single-feed grid below instead.
  const dashboard = !category && !activeCreator

  const { data: feedData, isLoading: feedLoading } = useQuery({
    queryKey: ['videos-following-feed', 'tiktok'],
    queryFn: () => getFollowingFeed('tiktok'),
    enabled: enabled && creators.length > 0,
  })
  const latestItems = feedData?.items ?? []
  const items = useMemo(() => {
    if (!activeCreator) return latestItems
    return latestItems.filter((it) => it.creator?.id === activeCreator)
  }, [latestItems, activeCreator])

  // Category chip selected: a flat grid for that category (cold load takes a few seconds
  // the first time while yt-dlp extracts the first profiles; cached ten minutes after).
  const categoryQuery = useQuery({
    queryKey: ['tiktok-popular', category],
    queryFn: () => browseSource('tiktok', { feed: category ?? undefined }),
    enabled: enabled && !!category,
    staleTime: 5 * 60_000,
  })

  const followMutation = useMutation({
    mutationFn: (handle: string) => addFollow('tiktok', handle),
    onSuccess: () => {
      setHandleInput('')
      toast.success('Subscribed')
      void qc.invalidateQueries({ queryKey: ['videos-follows'] })
      void qc.invalidateQueries({ queryKey: ['videos-following-feed', 'tiktok'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not subscribe to that creator'),
  })

  if (!enabled) {
    return (
      <PageContainer width="wide" className="pt-1 pb-8">
        <PageHeader title={SOURCE_META.tiktok.label} icon={SOURCE_META.tiktok.icon} gradient={SOURCE_META.tiktok.gradient}
          subtitle="Turned off by an admin." className="pt-4 pb-4" />
        <div className="py-8"><SourceDisabledCard label={SOURCE_META.tiktok.label} /></div>
      </PageContainer>
    )
  }

  return (
    <PageContainer width="wide" className="pt-1 pb-8">
      <PageHeader
        title={SOURCE_META.tiktok.label}
        icon={SOURCE_META.tiktok.icon}
        gradient={SOURCE_META.tiktok.gradient}
        subtitle={creators.length > 0 ? 'Latest from the creators you subscribe to.' : 'Popular right now. Subscribe to creators to make this feed yours.'}
        className="pt-4 pb-4"
        actions={
          <form
            className="flex shrink-0 gap-2"
            onSubmit={(e) => { e.preventDefault(); const h = handleInput.trim().replace(/^@/, ''); if (h) followMutation.mutate(h) }}
          >
            <Input value={handleInput} onChange={(e) => setHandleInput(e.target.value)}
              placeholder="Subscribe to @creator…" className="h-9 w-44" autoComplete="off" />
            <Button type="submit" size="sm" variant="outline" className="gap-1" disabled={!handleInput.trim() || followMutation.isPending}>
              <Plus className="size-4" /> Subscribe
            </Button>
          </form>
        }
      />

      <div className="mb-5 flex items-center gap-3">
        <ChipRow className="mb-0 min-w-0 flex-1">
          <Chip label="Home" active={dashboard} activeClassName={SOURCE_META.tiktok.pillActiveClass}
            onClick={() => { setActiveCreator(null); setCategory(null) }} />
          {categories.map((f) => (
            <Chip key={f.id} label={f.label} activeClassName={SOURCE_META.tiktok.pillActiveClass}
              active={category === f.id} onClick={() => { setCategory(f.id); setActiveCreator(null) }} />
          ))}
          {creators.length > 0 && <span className="mx-1 h-5 w-px shrink-0 self-center bg-border/70" aria-hidden />}
          {creators.map((f) => (
            <Chip key={f.id} label={f.title} active={activeCreator === f.externalId} activeClassName={SOURCE_META.tiktok.pillActiveClass}
              onClick={() => { setActiveCreator(activeCreator === f.externalId ? null : f.externalId); setCategory(null) }} />
          ))}
        </ChipRow>
        <ViewToggle value={view} onChange={setView} className="shrink-0" />
      </div>

      {dashboard ? (
        <div className="space-y-10">
          <SourceHomeSections
            source="tiktok"
            view={view}
            discovery={tiktokSource?.discovery ?? []}
            continueWatching={continueWatching}
            creators={creatorEntries}
            latestItems={items}
            latestLoading={enabled && creators.length > 0 && feedLoading}
          />
          <SourceExploreGrid source="tiktok" view={view} />
        </div>
      ) : category ? (
        categoryQuery.isLoading ? (
          <SkeletonCards count={12} className="xl:grid-cols-4" />
        ) : (categoryQuery.data?.items.length ?? 0) > 0 ? (
          <HubVideoCollection items={categoryQuery.data!.items} view={view} showSource={false} />
        ) : (
          <p className="py-20 text-center text-sm text-muted-foreground">Nothing here yet.</p>
        )
      ) : feedLoading ? (
        <SkeletonCards count={12} className="xl:grid-cols-4" />
      ) : items.length === 0 ? (
        <p className="py-20 text-center text-sm text-muted-foreground">
          Nothing here yet. New uploads appear within about 15 minutes of subscribing.
        </p>
      ) : (
        <HubVideoCollection items={items} view={view} showSource={false} />
      )}

      {dashboard && creators.length === 0 && !feedLoading && (
        <div className="mt-10 flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
          <UserRound className="mb-3 size-10 opacity-30" />
          <p className="text-sm font-medium">Subscribe to a TikTok creator to build your feed</p>
          <p className="mt-1 max-w-sm text-xs">
            Add an @handle above, or paste any TikTok link into{' '}
            <Link to="/videos/clip" className="inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-2">
              <Link2 className="size-3" /> Clip a Link
            </Link>{' '}
            to watch or save it.
          </p>
        </div>
      )}
    </PageContainer>
  )
}
