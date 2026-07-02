import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, Plus, Podcast } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { proxyImg } from '@/lib/img'
import {
  getSubscriptions, subscribePodcast, matchSubscription, type DirectoryResult,
} from '@/lib/podcast/api'

/** Where a directory card's body click lands: the full-page pre-subscribe preview,
 *  carrying seed params so the hero paints instantly while the feed loads. */
function previewHref(result: DirectoryResult): string {
  const p = new URLSearchParams()
  if (result.feedUrl) p.set('feedUrl', result.feedUrl)
  if (result.itunesId) p.set('itunesId', String(result.itunesId))
  p.set('title', result.title)
  if (result.artworkUrl) p.set('artworkUrl', result.artworkUrl)
  if (result.author) p.set('author', result.author)
  if (result.genre) p.set('genre', result.genre)
  return `/podcasts/preview?${p}`
}

/** A real podcast from the directory (search result or chart row) with a Subscribe button.
 *  Clicking the card opens the full-page feed-backed preview (description, categories,
 *  latest episodes) before subscribing; once subscribed the card links straight to the show. */
export function DirectoryCard({ result }: { result: DirectoryResult }) {
  const qc = useQueryClient()
  const { data: subs = [] } = useQuery({ queryKey: ['podcast-subscriptions'], queryFn: getSubscriptions })
  const [pending, setPending] = useState(false)
  // Chart rows subscribed this session match by the show id from the response,
  // even before the refetched subscription list carries the resolved feed URL.
  const [localShowId, setLocalShowId] = useState<string | null>(null)

  const matched = matchSubscription(result, subs)
  const subscribedShowId = localShowId ?? matched?.showId ?? null
  const subscribed = !!subscribedShowId

  async function handleSubscribe() {
    setPending(true)
    try {
      const show = await subscribePodcast({
        feedUrl: result.feedUrl ?? undefined,
        itunesId: result.itunesId ?? undefined,
        seed: {
          title: result.title,
          artworkUrl: result.artworkUrl ?? undefined,
          author: result.author ?? undefined,
          genre: result.genre ?? undefined,
        },
      })
      setLocalShowId(show.id)
      toast.success(`Subscribed to ${result.title}`)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['podcast-subscriptions'] }),
        qc.invalidateQueries({ queryKey: ['podcast-shows'] }),
        qc.invalidateQueries({ queryKey: ['podcast-feed'] }),
      ])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not subscribe to this podcast.')
    } finally {
      setPending(false)
    }
  }

  const body = (
    <>
      <Artwork url={result.artworkUrl} title={result.title} />
      <p className="mt-2 truncate text-sm font-semibold">{result.title}</p>
      {result.author && <p className="truncate text-xs text-muted-foreground">{result.author}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {result.genre && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{result.genre}</span>
        )}
        {result.episodeCount != null && result.episodeCount > 0 && (
          <span className="text-[10px] text-muted-foreground">{result.episodeCount} {result.episodeCount === 1 ? 'episode' : 'episodes'}</span>
        )}
      </div>
    </>
  )

  return (
    <div className="flex flex-col rounded-2xl border border-border/40 bg-card p-3">
      <Link
        to={subscribedShowId ? `/podcasts/show/${subscribedShowId}` : previewHref(result)}
        aria-label={subscribed ? result.title : `About ${result.title}`}
        className="group min-w-0"
      >
        {body}
      </Link>
      <div className="mt-3">
        <button
          onClick={() => void handleSubscribe()}
          disabled={pending || subscribed}
          className={cn(
            'flex w-full items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
            subscribed
              ? 'border border-border text-muted-foreground'
              : 'bg-brand text-brand-foreground hover:opacity-90 disabled:opacity-60',
          )}
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" />
            : subscribed ? <Check className="size-3.5" />
            : <Plus className="size-3.5" />}
          {pending ? 'Subscribing…' : subscribed ? 'Subscribed' : 'Subscribe'}
        </button>
      </div>
    </div>
  )
}

/** Square rounded cover — remote art through the image proxy, icon fallback. */
function Artwork({ url, title }: { url: string | null; title: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-muted">
      <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/40">
        <Podcast className="size-10" />
      </div>
      {url && !failed && (
        <img
          src={proxyImg(url)}
          alt={title}
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </div>
  )
}
