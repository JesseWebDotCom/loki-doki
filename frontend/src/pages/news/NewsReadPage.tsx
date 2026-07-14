import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Headphones, Pause, Play, RefreshCw, Square } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ArticleReader } from '@/components/shared/ArticleReader'
import { AppTabBar } from '@/components/shared/AppTabBar'
import { NewsAiSummary } from '@/components/news/NewsAiSummary'
import { NewsRelatedVideos } from '@/components/news/NewsRelatedVideos'
import { useArticleNarration } from '@/hooks/useArticleNarration'
import { getItemContent, getArticleByUrl, type FeedContent } from '@/lib/feeds/api'

type SideTab = 'summary' | 'videos'

const readerNoticeClassName = 'mx-auto max-w-[50rem] px-5 pt-6'

function readerSourceLabel(source: NonNullable<FeedContent['readerSource']>): string {
  if (source === 'social') return 'Readable copy loaded from the publisher social preview.'
  if (source === 'subscriber') return 'Readable copy loaded with the configured site access.'
  if (source === 'browser') return 'Readable copy rendered locally.'
  if (source === 'ladder') return 'Readable copy loaded through the configured reader proxy.'
  if (source === 'archive.is') return 'Readable copy recovered from archive.is.'
  if (source === 'wayback') return 'Readable copy recovered from Wayback.'
  return ''
}

// Full-screen article reader, opened either from a subscribed feed item (/news/read/:id,
// backed by a feedItems row) or a headline card with no such row (/news/reader?url=...,
// extracted live - see the News category/home "Top Stories" cards).
export function NewsReadPage() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const url = searchParams.get('url')
  const navigate = useNavigate()
  const [tab, setTab] = useState<SideTab>('summary')
  const [retryAttempt, setRetryAttempt] = useState(0)
  const { data, isLoading, isFetching } = useQuery({
    queryKey: id ? ['feed-content', id, retryAttempt] : ['news-article', url, retryAttempt],
    queryFn: () => (id ? getItemContent(id, { force: retryAttempt > 0 }) : getArticleByUrl(url!)),
    enabled: !!id || !!url,
  })
  // Narration keys off the feed item id when there is one, else the URL (ephemeral
  // headline cards have no id) - either is a stable per-article identity for the
  // resume-point it persists to localStorage.
  const narration = useArticleNarration({ id: id ?? url ?? '', contentHtml: data?.contentHtml })

  return (
    <div className="flex flex-col">
      <div className="glass-chrome sticky top-0 z-10 flex items-center gap-2 border-b border-border/40 px-4 py-2.5">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(-1)} title="Back"><ArrowLeft className="size-4" /></Button>
        <span className="flex-1 truncate text-sm font-medium">{data?.title ?? ''}</span>
        {narration.available && (
          narration.status === 'idle' ? (
            <Button variant="ghost" size="icon-sm" onClick={() => narration.start()} className="text-muted-foreground hover:text-foreground"
              title={narration.hasResumePoint ? 'Resume listening' : 'Listen to this article'}>
              <Headphones className="size-4" />
            </Button>
          ) : (
            <div className="flex items-center gap-0.5 rounded-control border border-border/50 px-1 py-0.5">
              {narration.status === 'playing' ? (
                <Button variant="ghost" size="icon-sm" className="size-6" onClick={narration.pause} title="Pause"><Pause className="size-3.5" /></Button>
              ) : (
                <Button variant="ghost" size="icon-sm" className="size-6" onClick={narration.resume} title="Resume"><Play className="size-3.5" /></Button>
              )}
              <Button variant="ghost" size="icon-sm" className="size-6" onClick={narration.stop} title="Stop"><Square className="size-3.5" /></Button>
              <span className="px-1 text-[10px] tabular-nums text-muted-foreground">¶ {narration.progress.paragraph}/{narration.progress.total}</span>
            </div>
          )
        )}
        {data?.url && (
          <Button asChild variant="ghost" size="icon-sm" className={cn('text-muted-foreground hover:text-foreground', narration.available && 'ml-1')}>
            <a href={data.url} target="_blank" rel="noopener noreferrer" title="Open original" aria-label="Open original"><ExternalLink className="size-4" /></a>
          </Button>
        )}
      </div>
      {/* Article flows in normal document flow (#main-scroll, the app shell's scroll container,
          scrolls the whole route). The aside is `lg:fixed` - fully decoupled from scrolling
          entirely, rather than `sticky` (which depends on ancestor/scroll-container details
          that are easy to get subtly wrong) - so it truly never moves once positioned. Since
          `fixed` takes it out of flow, the spacer div below reserves its width in the row so the
          article doesn't render underneath it. Offsets are measured against the actual rendered
          chrome (this page's own 49px topbar + the app shell's 48px breadcrumb bar above
          #main-scroll = 97px, and the aside's right edge sits flush with the viewport edge on
          this app's overlay scrollbars) - not guessed. */}
      <div className="flex flex-col lg:flex-row">
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="flex flex-col items-center gap-3 py-24 text-muted-foreground"><Spinner size="lg" className="size-7" /><p>Loading article…</p></div>
          ) : (
            <>
              {data?.teaserOnly && (
                <div className={readerNoticeClassName}>
                  <div className="flex flex-col gap-3 rounded-card border border-border/50 bg-secondary/40 px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                    <p>
                      Showing the feed's preview. The site blocks automated readers, so the full story is only on{' '}
                      {data.url ? (
                        <a href={data.url} target="_blank" rel="noopener noreferrer" className="text-brand underline underline-offset-2">the original site</a>
                      ) : 'the original site'}.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => setRetryAttempt((attempt) => attempt + 1)}
                      disabled={isFetching}
                    >
                      {isFetching ? <Spinner size="sm" /> : <RefreshCw className="size-3.5" />}
                      Try again
                    </Button>
                  </div>
                </div>
              )}
              {!data?.teaserOnly && data?.readerSource && data.readerSource !== 'direct' && (
                <div className={readerNoticeClassName}>
                  <p className="rounded-card border border-brand/20 bg-brand/10 px-4 py-3 text-sm text-muted-foreground">
                    {readerSourceLabel(data.readerSource)}{' '}
                    {data.archiveUrl && (
                      <a href={data.archiveUrl} target="_blank" rel="noopener noreferrer" className="text-brand underline underline-offset-2">Open archived page</a>
                    )}
                  </p>
                </div>
              )}
              <ArticleReader title={data?.title} byline={data?.author} siteName={data?.siteName} url={data?.url}
                leadImage={data?.teaserOnly ? data?.imageUrl : undefined}
                contentHtml={data?.contentHtml} readingMins={data?.readingMins} maxWidthClassName="max-w-[50rem]" />
            </>
          )}
        </div>
        {!isLoading && data && (
          <>
            <div className="hidden shrink-0 lg:block lg:w-[26rem]" aria-hidden="true" />
            <aside className="min-w-0 border-border/40 p-4 lg:fixed lg:right-0 lg:top-[97px] lg:flex lg:h-[calc(100dvh-97px)] lg:w-[26rem] lg:min-h-0 lg:flex-col lg:border-l">
              {/* Related videos next to an obituary would be tone-deaf regardless of what the
                  search happens to turn up - just show the summary, no tab switcher needed for
                  a single view. */}
              {data.isObituary ? (
                <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                  <NewsAiSummary id={id} url={id ? undefined : (url ?? undefined)} />
                </div>
              ) : (
                <>
                  <AppTabBar
                    tabs={[{ id: 'summary' as SideTab, label: 'Summary' }, { id: 'videos' as SideTab, label: 'Related videos', shortLabel: 'Videos' }]}
                    value={tab}
                    onChange={setTab}
                    className="shrink-0"
                  />
                  <div className="mt-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                    {tab === 'summary' && <NewsAiSummary id={id} url={id ? undefined : (url ?? undefined)} />}
                    {tab === 'videos' && data.title && <NewsRelatedVideos query={data.title} />}
                  </div>
                </>
              )}
            </aside>
          </>
        )}
      </div>
    </div>
  )
}
