import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Mic, Plus, ExternalLink } from 'lucide-react'
import {
  getShowPodcast,
  createShowPodcast,
  nextShowPodcastBatch,
  type PodcastEpisodeLite,
} from '@/lib/shows/api'
import { getMoviePodcastApi, createMoviePodcast } from '@/lib/movies/api'

function statusLine(episodes: { status: string }[]): string {
  const ready = episodes.filter((e) => e.status === 'ready').length
  const working = episodes.filter((e) => e.status === 'pending' || e.status === 'generating').length
  const failed = episodes.filter((e) => e.status === 'failed').length
  const parts = [`${ready} ready`]
  if (working) parts.push(`${working} generating`)
  if (failed) parts.push(`${failed} failed`)
  return parts.join(' · ')
}

function anyWorking(episodes: { status: string }[]): boolean {
  return episodes.some((e) => e.status === 'pending' || e.status === 'generating')
}

function EpisodeMini({ ep }: { ep: PodcastEpisodeLite }) {
  return (
    <div className="flex items-center gap-2 py-1.5 text-sm">
      {ep.status === 'ready' ? (
        <Mic className="size-3.5 shrink-0 text-emerald-500" />
      ) : ep.status === 'failed' ? (
        <Mic className="size-3.5 shrink-0 text-rose-500" />
      ) : (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate">{ep.title}</span>
    </div>
  )
}

export function ShowPodcastSection({ showId }: { showId: number }) {
  const qc = useQueryClient()
  const key = ['show-podcast', showId]
  const { data: podcast, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => getShowPodcast(showId),
    refetchInterval: (q) => (anyWorking((q.state.data as { episodes?: { status: string }[] } | null)?.episodes ?? []) ? 5000 : false),
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: key })
  const create = useMutation({ mutationFn: () => createShowPodcast(showId), onSuccess: invalidate })
  const next = useMutation({ mutationFn: () => nextShowPodcastBatch(showId), onSuccess: invalidate })
  const busy = create.isPending || next.isPending

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>

  if (!podcast) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Generate an AI podcast that discusses this show episode by episode — your companions host it.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => create.mutate()}
          className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:opacity-90 disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
          Generate Podcast
        </button>
      </div>
    )
  }

  const episodes = [...podcast.episodes].sort((a, b) => a.createdAt - b.createdAt)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{statusLine(episodes)}</p>
        <Link to={`/podcasts/show/${podcast.showId}`} className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
          <ExternalLink className="size-3" /> Open in Podcasts
        </Link>
      </div>
      <div className="rounded-lg border border-border/50 px-3 py-1.5">
        {episodes.slice(0, 8).map((ep) => (
          <EpisodeMini key={ep.id} ep={ep} />
        ))}
        {episodes.length > 8 && <p className="py-1.5 text-xs text-muted-foreground">+{episodes.length - 8} more</p>}
      </div>
      {podcast.remaining > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => next.mutate()}
          className="inline-flex items-center gap-2 rounded-lg bg-foreground/10 px-4 py-2 text-sm font-medium hover:bg-foreground/15 disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          Generate next batch ({podcast.remaining} left)
        </button>
      )}
    </div>
  )
}

export function MoviePodcastSection({ title, year, overview }: { title: string; year: number | null; overview: string }) {
  const qc = useQueryClient()
  const key = ['movie-podcast', title]
  const { data: podcast, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => getMoviePodcastApi(title),
    refetchInterval: (q) => (anyWorking((q.state.data as { episodes?: { status: string }[] } | null)?.episodes ?? []) ? 5000 : false),
  })
  const create = useMutation({
    mutationFn: () => createMoviePodcast(title, year, overview),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  })

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>

  if (!podcast) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Generate an AI deep-dive podcast discussing this film — hosted by your companions.</p>
        <button
          type="button"
          disabled={create.isPending}
          onClick={() => create.mutate()}
          className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:opacity-90 disabled:opacity-60"
        >
          {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
          Generate Podcast
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{statusLine(podcast.episodes)}</p>
        <Link to={`/podcasts/show/${podcast.showId}`} className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
          <ExternalLink className="size-3" /> Open in Podcasts
        </Link>
      </div>
      <div className="rounded-lg border border-border/50 px-3 py-1.5">
        {podcast.episodes.map((ep) => (
          <EpisodeMini key={ep.id} ep={ep as PodcastEpisodeLite} />
        ))}
      </div>
    </div>
  )
}
