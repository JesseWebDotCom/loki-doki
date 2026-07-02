import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ChevronRight, ExternalLink, Loader2, Plus, Podcast } from 'lucide-react'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import {
  EPISODE_PAGE_SIZE, ShowHero, EpisodesToolbar, EpisodeListSkeleton, EpisodeEmptyState,
  ShowMoreButton, EpisodeRowFrame, EpisodeRowTitle, EpisodeRowMeta, EpisodeRowDescription,
} from '@/components/podcast/ShowDetailParts'
import {
  previewDirectory, subscribePodcast, getSubscriptions, matchSubscription,
  type DirectoryPreview,
} from '@/lib/podcast/api'
import { fmtDate, fmtDuration } from '@/lib/podcast/format'

type PreviewEpisode = DirectoryPreview['episodes'][number]

/** Full-page pre-subscribe details for a directory podcast — the RssShowDetail look,
 *  fed straight from the show's feed. Seed params (?title/artworkUrl/…) paint the hero
 *  instantly while the feed loads; Subscribe lands on the real show page. */
export function PodcastPreviewPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [params] = useSearchParams()

  const feedUrl = params.get('feedUrl')
  const itunesId = params.get('itunesId') ? Number(params.get('itunesId')) : null
  const seed = {
    title: params.get('title'),
    artworkUrl: params.get('artworkUrl'),
    author: params.get('author'),
    genre: params.get('genre'),
  }
  const hasTarget = !!feedUrl || !!itunesId

  const [query, setQuery] = useState('')
  const [sortNewest, setSortNewest] = useState(true)
  const [visibleCount, setVisibleCount] = useState(EPISODE_PAGE_SIZE)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [subscribing, setSubscribing] = useState(false)

  const { data: preview, isLoading, error } = useQuery({
    queryKey: ['podcast-directory-preview', feedUrl ?? itunesId],
    queryFn: () => previewDirectory({ feedUrl, itunesId }),
    enabled: hasTarget,
    staleTime: 6 * 60 * 60 * 1000,
    retry: 1,
  })

  // Already subscribed? Skip the preview and go to the real show page.
  const { data: subs = [] } = useQuery({ queryKey: ['podcast-subscriptions'], queryFn: getSubscriptions })
  const matched = useMemo(() => matchSubscription({
    feedUrl: preview?.feedUrl ?? feedUrl,
    title: preview?.title ?? seed.title ?? '',
    author: preview?.author ?? seed.author,
  }, subs), [preview, subs, feedUrl, seed.title, seed.author])
  useEffect(() => {
    if (matched && !subscribing) navigate(`/podcasts/show/${matched.showId}`, { replace: true })
  }, [matched, subscribing, navigate])

  const title = preview?.title ?? seed.title
  const author = preview?.author ?? seed.author
  const artwork = preview?.imageUrl ?? seed.artworkUrl
  const badges = preview?.categories?.length ? preview.categories : (seed.genre ? [seed.genre] : [])

  const epKey = (ep: PreviewEpisode) => `${ep.publishedAt ?? ''}::${ep.title}`
  const sorted = useMemo(() => {
    const episodes = preview?.episodes ?? []
    const q = query.trim().toLowerCase()
    const list = q ? episodes.filter(e => e.title.toLowerCase().includes(q)) : episodes
    return [...list].sort((a, b) => sortNewest
      ? (b.publishedAt ?? 0) - (a.publishedAt ?? 0)
      : (a.publishedAt ?? 0) - (b.publishedAt ?? 0))
  }, [preview?.episodes, query, sortNewest])
  useEffect(() => { setVisibleCount(EPISODE_PAGE_SIZE) }, [query, sortNewest])
  const visible = sorted.slice(0, visibleCount)

  async function handleSubscribe() {
    setSubscribing(true)
    try {
      const show = await subscribePodcast({
        feedUrl: preview?.feedUrl ?? feedUrl ?? undefined,
        itunesId: itunesId ?? undefined,
        seed: {
          title: title ?? undefined,
          artworkUrl: artwork ?? undefined,
          author: author ?? undefined,
          genre: seed.genre ?? undefined,
        },
      })
      toast.success(`Subscribed to ${show.name}`)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['podcast-subscriptions'] }),
        qc.invalidateQueries({ queryKey: ['podcast-shows'] }),
        qc.invalidateQueries({ queryKey: ['podcast-feed'] }),
      ])
      navigate(`/podcasts/show/${show.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not subscribe to this podcast.')
      setSubscribing(false)
    }
  }

  if (!hasTarget) {
    return (
      <div className="px-6 py-20 text-center text-sm text-muted-foreground">
        No podcast selected. <Link to="/podcasts/browse" className="text-brand hover:underline">Back to Browse</Link>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6 pb-24">
      {/* Back nav */}
      <Link to="/podcasts/browse" className="mb-5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 rotate-180" /> Browse
      </Link>

      {/* ── Hero — seed-painted while the feed loads ── */}
      {title ? (
        <ShowHero
          cover={<PreviewCover url={artwork} title={title} />}
          badges={badges}
          title={title}
          author={author}
          meta={preview ? <>
            <span>{preview.episodeCount}{preview.episodeCount >= 300 ? '+' : ''} {preview.episodeCount === 1 ? 'episode' : 'episodes'}</span>
            {preview.link && (
              <span>· <a href={preview.link} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-0.5 hover:text-foreground hover:underline">
                Website <ExternalLink className="size-3" />
              </a></span>
            )}
          </> : undefined}
          description={preview?.description}
          actions={<SubscribeButton pending={subscribing} onClick={() => void handleSubscribe()} />}
        />
      ) : isLoading ? (
        <HeroSkeleton />
      ) : null}

      {/* ── Feed error ── */}
      {!!error && !isLoading && (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-2xl border border-border/40 bg-card py-12 text-center">
          <AlertCircle className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : 'Could not load show details.'}
          </p>
          <Link to="/podcasts/browse" className="text-xs font-semibold text-brand hover:underline">Back to Browse</Link>
        </div>
      )}

      {/* ── Episode list ── */}
      {!error && (
        <>
          <EpisodesToolbar
            count={sorted.length}
            sortNewest={sortNewest}
            onToggleSort={() => setSortNewest(v => !v)}
            query={query}
            onQueryChange={setQuery}
            hint="Subscribe to play and download episodes."
          />

          {isLoading || !preview ? (
            <EpisodeListSkeleton />
          ) : sorted.length === 0 ? (
            <EpisodeEmptyState primary={query ? 'No episodes match your search.' : 'No episodes yet.'} />
          ) : (
            <>
              <div className="divide-y divide-border/30">
                {visible.map(ep => (
                  <PreviewEpisodeRow
                    key={epKey(ep)}
                    episode={ep}
                    expanded={expandedKey === epKey(ep)}
                    onToggle={() => setExpandedKey(cur => cur === epKey(ep) ? null : epKey(ep))}
                  />
                ))}
              </div>
              {visibleCount < sorted.length && (
                <ShowMoreButton remaining={sorted.length - visibleCount} onClick={() => setVisibleCount(v => v + EPISODE_PAGE_SIZE)} />
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

/** Brand Subscribe pill with a pending spinner. */
function SubscribeButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={pending}
      className="flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground hover:opacity-90 disabled:opacity-60">
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
      {pending ? 'Subscribing…' : 'Subscribe'}
    </button>
  )
}

/** Read-only episode row — expands inline for the full description, no play/download. */
function PreviewEpisodeRow({ episode, expanded, onToggle }: {
  episode: PreviewEpisode
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <EpisodeRowFrame onToggle={onToggle} expanded={expanded} highlight={expanded && 'bg-accent/10'}>
      <EpisodeRowTitle title={episode.title} expanded={expanded} />
      <EpisodeRowMeta>
        {episode.publishedAt && <span>{fmtDate(episode.publishedAt)}</span>}
        {episode.durationSec ? <span>· {fmtDuration(episode.durationSec)}</span> : null}
      </EpisodeRowMeta>
      {episode.description && <EpisodeRowDescription text={episode.description} expanded={expanded} />}
    </EpisodeRowFrame>
  )
}

/** 176px hero cover — remote art through the image proxy, icon fallback. */
function PreviewCover({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="relative size-44 overflow-hidden rounded-2xl bg-muted">
      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/40">
        <Podcast className="size-12" />
      </div>
      {url && !failed && (
        <img src={proxyImg(url)} alt={title} onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover" />
      )}
    </div>
  )
}

/** Hero placeholder when there are no seed params to paint from. */
function HeroSkeleton() {
  return (
    <div className="flex flex-col gap-6 sm:flex-row">
      <div className="size-44 shrink-0 animate-pulse rounded-2xl bg-muted/50" />
      <div className="min-w-0 flex-1 space-y-3 sm:pt-1">
        <div className="h-3 w-24 animate-pulse rounded bg-muted/50" />
        <div className="h-8 w-2/3 animate-pulse rounded bg-muted/50" />
        <div className="h-4 w-40 animate-pulse rounded bg-muted/50" />
        <div className="h-16 w-full max-w-2xl animate-pulse rounded bg-muted/50" />
      </div>
    </div>
  )
}
