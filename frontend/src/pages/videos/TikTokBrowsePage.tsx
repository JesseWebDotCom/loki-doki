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
import {
  addFollow, browseSource, getFollowingFeed, getHubHistory, getVideoSources, listFollows,
  type HubVideoItem,
} from '@/lib/videos/api'
import { SOURCE_META } from '@/lib/videos/sources'
import { HubVideoCollection } from '@/components/videos/HubVideoCollection'
import { HubMediaShelf } from '@/components/videos/HubMediaShelf'
import { HubCreatorRail } from '@/components/videos/HubCreatorRail'

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
  const categories = sourcesData?.sources.find((s) => s.source === 'tiktok')?.browseFeeds ?? []

  const { data: followsData } = useQuery({ queryKey: ['videos-follows'], queryFn: listFollows })
  const creators = useMemo(() => (followsData?.follows ?? []).filter((f) => f.source === 'tiktok'), [followsData])

  const { data: hubHist } = useQuery({ queryKey: ['videos-history'], queryFn: getHubHistory })
  const continueWatching = useMemo<HubVideoItem[]>(() => (hubHist?.history ?? [])
    .filter((r) => r.source === 'tiktok' && !r.completed && r.positionSec > 5)
    .map((r) => ({
      source: r.source, id: r.videoId, url: '', title: r.title,
      creator: r.creatorName ? { id: '', name: r.creatorName } : null,
      thumbnailUrl: r.thumbnailUrl, durationSec: r.durationSec, vertical: true,
    })), [hubHist])

  const { data: feedData, isLoading } = useQuery({
    queryKey: ['videos-following-feed', 'tiktok'],
    queryFn: () => getFollowingFeed('tiktok'),
    enabled: creators.length > 0,
  })

  // Zero-setup surface: popular creators' latest videos (cold load takes a few seconds
  // while yt-dlp extracts the first profiles; cached ten minutes after that).
  const showPopular = creators.length === 0 || category !== null
  const popularQuery = useQuery({
    queryKey: ['tiktok-popular', category ?? 'popular'],
    queryFn: () => browseSource('tiktok', { feed: category ?? undefined }),
    enabled: showPopular,
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

      <div className="mb-5 flex items-center gap-3">
        <ChipRow className="mb-0 min-w-0 flex-1">
          {creators.length > 0 && (
            <Chip label="Following" active={activeCreator === null && category === null} activeClassName={SOURCE_META.tiktok.pillActiveClass}
              onClick={() => { setActiveCreator(null); setCategory(null) }} />
          )}
          {categories.map((f) => (
            <Chip key={f.id} label={f.label} activeClassName={SOURCE_META.tiktok.pillActiveClass}
              active={category === f.id || (creators.length === 0 && category === null && f.id === 'popular')}
              onClick={() => { setCategory(f.id); setActiveCreator(null) }} />
          ))}
          {creators.length > 0 && <span className="mx-1 h-5 w-px shrink-0 self-center bg-border/70" aria-hidden />}
          {creators.map((f) => (
            <Chip key={f.id} label={f.title} active={activeCreator === f.externalId} activeClassName={SOURCE_META.tiktok.pillActiveClass}
              onClick={() => { setActiveCreator(activeCreator === f.externalId ? null : f.externalId); setCategory(null) }} />
          ))}
        </ChipRow>
        <ViewToggle value={view} onChange={setView} className="shrink-0" />
      </div>

      {showPopular ? (
        popularQuery.isLoading ? (
          <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
            <SkeletonCards count={12} className="w-full md:grid-cols-4 xl:grid-cols-6" />
            <p className="text-xs">Fetching popular creators, this takes a few seconds the first time…</p>
          </div>
        ) : (popularQuery.data?.items.length ?? 0) > 0 ? (
          <HubVideoCollection items={popularQuery.data!.items} view={view} showSource={false} />
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
        <div className="space-y-10">
          {!activeCreator && continueWatching.length > 0 && (
            <HubMediaShelf title="Continue watching" items={continueWatching} view={view} showSource={false} />
          )}
          {!activeCreator && creators.length > 0 && (
            <HubCreatorRail title="Following" source="tiktok"
              creators={creators.map((c) => ({ id: c.externalId, title: c.title, thumbnailUrl: c.thumbnailUrl ?? null }))} />
          )}
          <section>
            <HubVideoCollection items={items} view={view} showSource={false} />
          </section>
        </div>
      )}
    </PageContainer>
  )
}
