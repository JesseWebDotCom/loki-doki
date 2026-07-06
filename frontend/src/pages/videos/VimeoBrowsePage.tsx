import { useMemo, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SkeletonCards } from '@/components/shared/SkeletonBlocks'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/context/AuthContext'
import { toast } from '@/lib/toast'
import { browseSource, getVideoSources, putVimeoConfig } from '@/lib/videos/api'
import { HubVideoCard } from '@/components/videos/HubVideoCard'
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
  const { data: sourcesData, refetch: refetchSources } = useQuery({ queryKey: ['videos-sources'], queryFn: getVideoSources })
  const vimeo = sourcesData?.sources.find((s) => s.source === 'vimeo')
  const configured = vimeo?.status.configured ?? true

  const feedQuery = useInfiniteQuery({
    queryKey: ['vimeo-browse'],
    queryFn: ({ pageParam }) => browseSource('vimeo', { cursor: pageParam }),
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
      eyebrow="Videos"
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
      {feedQuery.isLoading ? (
        <SkeletonCards count={12} className="xl:grid-cols-4" />
      ) : feedQuery.isError ? (
        <Card variant="flat" className="p-5 text-sm text-muted-foreground">
          {feedQuery.error instanceof Error ? feedQuery.error.message : 'Could not load Vimeo right now.'}
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 xl:grid-cols-4">
            {items.map((it) => <HubVideoCard key={`${it.source}:${it.id}`} item={it} showSource={false} />)}
          </div>
          {feedQuery.hasNextPage && (
            <div className="mt-8 flex justify-center">
              <Button variant="outline" onClick={() => void feedQuery.fetchNextPage()} disabled={feedQuery.isFetchingNextPage}>
                {feedQuery.isFetchingNextPage ? <Spinner size="sm" /> : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </PageContainer>
  )
}
