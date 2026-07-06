import { useMemo, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { PageHeader } from '@/components/shared/PageHeader'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { ViewToggle } from '@/components/shared/ViewToggle'
import { useViewPreference } from '@/hooks/useViewPreference'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/context/AuthContext'
import { toast } from '@/lib/toast'
import { browseSource, getHubHistory, getVideoSources, putVimeoConfig, type HubVideoItem } from '@/lib/videos/api'
import { HubVideoCollection } from '@/components/videos/HubVideoCollection'
import { HubMediaShelf } from '@/components/videos/HubMediaShelf'
import { SOURCE_META } from '@/lib/videos/sources'

function ConnectVimeoCard({ onConfigured }: { onConfigured: () => void }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [token, setToken] = useState('')
  const saveMutation = useMutation({
    mutationFn: () => putVimeoConfig(token.trim()),
    onSuccess: () => { toast.success('Vimeo connected'); onConfigured() },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save'),
  })

  return (
    // design-ok(adhoc-container): one-off centered connect card, not page chrome
    <Card className="mx-auto max-w-xl p-6">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-1 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Connect Vimeo</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Browsing Staff Picks and search need a free Vimeo API token. Pasted vimeo.com links work either way.
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Open <a href="https://developer.vimeo.com/apps" target="_blank" rel="noreferrer noopener" className="font-medium text-foreground underline underline-offset-2">developer.vimeo.com/apps</a> and create an app</li>
            <li>Generate a personal access token with the <span className="font-medium text-foreground">public</span> scope</li>
            <li>Paste the token below</li>
          </ol>
          {isAdmin ? (
            <form
              className="mt-4 flex gap-2"
              onSubmit={(e) => { e.preventDefault(); if (token.trim()) saveMutation.mutate() }}
            >
              <Input value={token} onChange={(e) => setToken(e.target.value)}
                placeholder="Vimeo API token" autoComplete="off" type="password" />
              <Button type="submit" disabled={!token.trim() || saveMutation.isPending}>
                {saveMutation.isPending ? <Spinner size="sm" className="text-primary-foreground" /> : 'Connect'}
              </Button>
            </form>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">Ask an admin to connect Vimeo on this page.</p>
          )}
        </div>
      </div>
    </Card>
  )
}

export function VimeoBrowsePage() {
  const qc = useQueryClient()
  const [feed, setFeed] = useState<string>('staffpicks')
  const [view, setView] = useViewPreference('videos.vimeo_view', 'grid')
  const { data: sourcesData, refetch: refetchSources } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources })
  const vimeo = sourcesData?.sources.find((s) => s.source === 'vimeo')
  const configured = vimeo?.status.configured ?? true
  const feeds = vimeo?.browseFeeds ?? []

  const { data: hubHist } = useQuery({ queryKey: ['videos-history'], queryFn: getHubHistory, enabled: configured })
  const continueWatching = useMemo<HubVideoItem[]>(() => (hubHist?.history ?? [])
    .filter((r) => r.source === 'vimeo' && !r.completed && r.positionSec > 5)
    .map((r) => ({
      source: r.source, id: r.videoId, url: '', title: r.title,
      creator: r.creatorName ? { id: '', name: r.creatorName } : null,
      thumbnailUrl: r.thumbnailUrl, durationSec: r.durationSec,
    })), [hubHist])

  const feedQuery = useInfiniteQuery({
    queryKey: ['vimeo-browse', feed],
    queryFn: ({ pageParam }) => browseSource('vimeo', { feed, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor,
    enabled: configured,
  })
  const items = useMemo(() => (feedQuery.data?.pages ?? []).flatMap((p) => p.items), [feedQuery.data])

  const header = (
    <PageHeader
      title={SOURCE_META.vimeo.label}
      icon={SOURCE_META.vimeo.icon}
      gradient={SOURCE_META.vimeo.gradient}
      subtitle="Staff Picks, handpicked by Vimeo."
      className="pt-4 pb-4"
    />
  )

  if (!configured) {
    return (
      <PageContainer width="wide" className="pt-1 pb-8">
        {header}
        <div className="py-8">
          <ConnectVimeoCard onConfigured={() => { void refetchSources(); void qc.invalidateQueries({ queryKey: ['videos-sources'] }) }} />
        </div>
      </PageContainer>
    )
  }

  return (
    <PageContainer width="wide" className="pt-1 pb-8">
      {header}
      <div className="mb-6 flex items-center gap-3">
        {feeds.length > 0 && (
          <ChipRow className="mb-0 min-w-0 flex-1">
            {feeds.map((f) => (
              <Chip key={f.id} label={f.label} active={feed === f.id} activeClassName={SOURCE_META.vimeo.pillActiveClass}
                onClick={() => setFeed(f.id)} />
            ))}
          </ChipRow>
        )}
        <ViewToggle value={view} onChange={setView} className="shrink-0" />
      </div>
      {feedQuery.isLoading ? (
        <SkeletonCards count={12} className="xl:grid-cols-4" />
      ) : feedQuery.isError ? (
        <Card variant="flat" className="p-5 text-sm text-muted-foreground">
          {feedQuery.error instanceof Error ? feedQuery.error.message : 'Could not load Vimeo right now.'}
        </Card>
      ) : (
        <div className="space-y-10">
          {feed === 'staffpicks' && continueWatching.length > 0 && (
            <HubMediaShelf title="Continue watching" items={continueWatching} view={view} showSource={false} />
          )}
          <section>
            <HubVideoCollection items={items} view={view} showSource={false} />
            {feedQuery.hasNextPage && (
              <div className="mt-8 flex justify-center">
                <Button variant="outline" onClick={() => void feedQuery.fetchNextPage()} disabled={feedQuery.isFetchingNextPage}>
                  {feedQuery.isFetchingNextPage ? <Spinner size="sm" /> : 'Load more'}
                </Button>
              </div>
            )}
          </section>
        </div>
      )}
    </PageContainer>
  )
}
