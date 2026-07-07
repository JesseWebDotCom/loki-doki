import { useMemo, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Plus } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { InfiniteLoadMore } from '@/components/videos/InfiniteLoadMore'
import { useAuth } from '@/context/AuthContext'
import { toast } from '@/lib/toast'
import {
  addFollow, browseSource, getHubHistory, getVideoSources, listFollows, putRedditConfig,
  type HubVideoItem,
} from '@/lib/videos/api'
import { HubVideoCollection } from '@/components/videos/HubVideoCollection'
import { HubMediaShelf } from '@/components/videos/HubMediaShelf'
import { HubCreatorRail } from '@/components/videos/HubCreatorRail'
import { SourceDisabledCard } from '@/components/videos/SourceDisabledCard'
import { SOURCE_META } from '@/lib/videos/sources'

/** Inline connect card: Reddit locked down anonymous access, so browsing needs a free
 *  registered app client id. Admins configure it right here (config belongs where the
 *  feature lives); everyone else sees who to ask. */
function ConnectRedditCard({ onConfigured }: { onConfigured: () => void }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [clientId, setClientId] = useState('')
  const saveMutation = useMutation({
    mutationFn: () => putRedditConfig(clientId.trim()),
    onSuccess: () => { toast.success('Reddit connected'); onConfigured() },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save'),
  })

  return (
    // design-ok(adhoc-container): one-off centered connect card, not page chrome
    <Card className="mx-auto max-w-xl p-6">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-1 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Connect Reddit</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Reddit requires a (free) registered app to browse. One-time setup, about two minutes:
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Open <a href="https://www.reddit.com/prefs/apps" target="_blank" rel="noreferrer noopener" className="font-medium text-foreground underline underline-offset-2">reddit.com/prefs/apps</a> (any reddit account works)</li>
            <li>Create an app: pick type <span className="font-medium text-foreground">installed app</span>, any name. The redirect URI is required but never used, so <span className="font-mono text-xs">http://localhost</span> is fine no matter how you reach this server</li>
            <li>Copy the client id shown under the app name and paste it below</li>
          </ol>
          {isAdmin ? (
            <form
              className="mt-4 flex gap-2"
              onSubmit={(e) => { e.preventDefault(); if (clientId.trim()) saveMutation.mutate() }}
            >
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)}
                placeholder="Reddit app client id" autoComplete="off" />
              <Button type="submit" disabled={!clientId.trim() || saveMutation.isPending}>
                {saveMutation.isPending ? <Spinner size="sm" className="text-primary-foreground" /> : 'Connect'}
              </Button>
            </form>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">Ask an admin to connect Reddit in this page.</p>
          )}
        </div>
      </div>
    </Card>
  )
}

export function RedditBrowsePage() {
  const qc = useQueryClient()
  const [activeFeed, setActiveFeed] = useState<string | null>(null)
  const [subInput, setSubInput] = useState('')
  const [view, setView] = useViewPreference('videos.reddit_view', 'grid')

  const { data: sourcesData, refetch: refetchSources } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources })
  const reddit = sourcesData?.sources.find((s) => s.source === 'reddit')
  const configured = reddit?.status.configured ?? true
  const enabled = reddit?.enabled ?? true

  const { data: followsData } = useQuery({ queryKey: ['videos-follows'], queryFn: listFollows, enabled: configured && enabled })
  const subs = useMemo(() => (followsData?.follows ?? []).filter((f) => f.source === 'reddit'), [followsData])

  const { data: hubHist } = useQuery({ queryKey: ['videos-history'], queryFn: getHubHistory, enabled: configured && enabled })
  const continueWatching = useMemo<HubVideoItem[]>(() => (hubHist?.history ?? [])
    .filter((r) => r.source === 'reddit' && !r.completed && r.positionSec > 5)
    .map((r) => ({
      source: r.source, id: r.videoId, url: '', title: r.title,
      creator: r.creatorName ? { id: '', name: r.creatorName } : null,
      thumbnailUrl: r.thumbnailUrl, durationSec: r.durationSec,
    })), [hubHist])

  const feedQuery = useInfiniteQuery({
    queryKey: ['reddit-browse', activeFeed],
    queryFn: ({ pageParam }) => browseSource('reddit', { feed: activeFeed ?? undefined, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor,
    enabled: configured && enabled,
  })
  const items = useMemo(() => (feedQuery.data?.pages ?? []).flatMap((p) => p.items), [feedQuery.data])

  const followMutation = useMutation({
    mutationFn: (sub: string) => addFollow('reddit', sub),
    onSuccess: () => {
      setSubInput('')
      toast.success('Following')
      void qc.invalidateQueries({ queryKey: ['videos-follows'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not follow that subreddit'),
  })

  const header = (extra?: React.ReactNode) => (
    <PageHeader
      title={SOURCE_META.reddit.label}
      icon={SOURCE_META.reddit.icon}
      gradient={SOURCE_META.reddit.gradient}
      subtitle={!enabled ? 'Turned off by an admin.' : configured ? 'Video posts from the communities you follow.' : 'Connect Reddit to browse video communities.'}
      className="pt-4 pb-4"
      actions={extra}
    />
  )

  if (!enabled) {
    return (
      <PageContainer width="wide" className="pt-1 pb-8">
        {header()}
        <div className="py-8"><SourceDisabledCard label={SOURCE_META.reddit.label} /></div>
      </PageContainer>
    )
  }

  if (!configured) {
    return (
      <PageContainer width="wide" className="pt-1 pb-8">
        {header()}
        <div className="py-8">
          <ConnectRedditCard onConfigured={() => { void refetchSources(); void qc.invalidateQueries({ queryKey: ['videos-sources'] }) }} />
        </div>
      </PageContainer>
    )
  }

  return (
    <PageContainer width="wide" className="pt-1 pb-8">
      {header(
        <form
          className="flex shrink-0 gap-2"
          onSubmit={(e) => { e.preventDefault(); const s = subInput.trim().replace(/^r\//, ''); if (s) followMutation.mutate(s) }}
        >
          <Input value={subInput} onChange={(e) => setSubInput(e.target.value)}
            placeholder="Follow a subreddit…" className="h-9 w-44" autoComplete="off" />
          <Button type="submit" size="sm" variant="outline" className="gap-1" disabled={!subInput.trim() || followMutation.isPending}>
            <Plus className="size-4" /> Follow
          </Button>
        </form>,
      )}

      <div className="mb-5 flex items-center gap-3">
        <ChipRow className="mb-0 min-w-0 flex-1">
          {(reddit?.browseFeeds ?? []).map((f) => (
            <Chip key={f.id} label={f.label} activeClassName={SOURCE_META.reddit.pillActiveClass}
              active={f.id === 'popular' ? activeFeed === null : activeFeed === f.id}
              onClick={() => setActiveFeed(f.id === 'popular' ? null : f.id)} />
          ))}
          {subs.length > 0 && <span className="mx-1 shrink-0 self-center h-5 w-px bg-border/70" aria-hidden />}
          {subs.map((f) => (
            <Chip key={f.id} label={f.title.replace(/^r\//, 'r/')} activeClassName={SOURCE_META.reddit.pillActiveClass}
              active={activeFeed === f.externalId} onClick={() => setActiveFeed(f.externalId)} />
          ))}
        </ChipRow>
        <ViewToggle value={view} onChange={setView} className="shrink-0" />
      </div>

      {feedQuery.isLoading ? (
        <SkeletonCards count={12} className="xl:grid-cols-4" />
      ) : feedQuery.isError ? (
        <Card variant="flat" className="p-5 text-sm text-muted-foreground">
          {feedQuery.error instanceof Error ? feedQuery.error.message : 'Could not load Reddit right now.'}
        </Card>
      ) : items.length === 0 ? (
        <p className="py-20 text-center text-sm text-muted-foreground">No playable video posts here right now.</p>
      ) : (
        <div className="space-y-10">
          {!activeFeed && continueWatching.length > 0 && (
            <HubMediaShelf title="Continue watching" items={continueWatching} view={view} showSource={false} />
          )}
          {!activeFeed && subs.length > 0 && (
            <HubCreatorRail title="Your communities" source="reddit"
              creators={subs.map((s) => ({ id: s.externalId, title: s.title, thumbnailUrl: s.thumbnailUrl ?? null }))} />
          )}
          <section>
            <HubVideoCollection items={items} view={view} showSource={false} />
            <InfiniteLoadMore
              hasNextPage={!!feedQuery.hasNextPage}
              isFetchingNextPage={feedQuery.isFetchingNextPage}
              fetchNextPage={() => void feedQuery.fetchNextPage()}
            />
          </section>
        </div>
      )}
    </PageContainer>
  )
}
