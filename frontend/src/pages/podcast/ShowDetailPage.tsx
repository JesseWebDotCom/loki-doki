import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight, Pencil, Sparkles, Video, Plus, Search, Loader2, Radio, ArrowUpDown,
  MoreHorizontal, Trash2, ListPlus, Music, Play, Pause,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { createPodcast, getChannelPage, getPlaylist } from '@/lib/youtube/api'
import { getBatchSize } from '@/lib/youtube/podcast'
import { ShowCover } from '@/components/podcast/ShowCover'
import { EpisodeRow } from '@/components/podcast/EpisodeRow'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { usePodcastUI } from '@/components/podcast/PodcastLayout'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  getShows, getEpisodes, generateEpisode, deleteShow, getHostCharacters, toTrack, stingerUrl, type Episode,
} from '@/lib/podcast/api'
import { fmtTotalRuntime, fmtDate } from '@/lib/podcast/format'

type Tab = 'episodes' | 'about'

export function ShowDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { openEdit } = usePodcastUI()
  const { closeIfShow } = usePodcastPlayback()
  const [tab, setTab] = useState<Tab>('episodes')
  const [query, setQuery] = useState('')
  const [sortNewest, setSortNewest] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [batching, setBatching] = useState(false)
  const [confirmDeleteShow, setConfirmDeleteShow] = useState(false)

  const { data: shows = [] } = useQuery({ queryKey: ['podcast-shows'], queryFn: getShows })
  const show = shows.find(s => s.id === id)

  const { data: episodes = [], isLoading } = useQuery({
    queryKey: ['podcast-episodes', id],
    queryFn: () => getEpisodes(id),
    refetchInterval: q => (q.state.data?.some((e: Episode) => e.status === 'generating' || e.status === 'pending') ? 4000 : false),
  })
  const { data: characters = [] } = useQuery({ queryKey: ['host-characters'], queryFn: getHostCharacters })

  const ready = episodes.filter(e => e.status === 'ready')
  // Any episode still in the queue/working — used to lock generation buttons so a new
  // batch can't pile on top of one already running.
  const anyGenerating = episodes.some(e => e.status === 'generating' || e.status === 'pending')
  const totalRuntime = ready.reduce((sum, e) => sum + (e.durationSec ?? 0), 0)
  const isYouTube = show?.segments?.some(s => s.type === 'youtube') || show?.source === 'app'

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? episodes.filter(e => e.title.toLowerCase().includes(q)) : episodes
    const ts = (e: Episode) => new Date(e.generatedAt ?? e.createdAt ?? 0).getTime()
    return [...list].sort((a, b) => sortNewest ? ts(b) - ts(a) : ts(a) - ts(b))
  }, [episodes, query, sortNewest])

  const readyTracks = ready.map(e => toTrack(e, { id, name: show?.name ?? '' }))

  async function handleGenerate() {
    setGenerating(true)
    try {
      await generateEpisode(id)
      await qc.invalidateQueries({ queryKey: ['podcast-episodes', id] })
    } finally { setGenerating(false) }
  }

  // Continue a YouTube-sourced show: pull the source's videos and make the next batch
  // of episodes (the backend skips videos already turned into episodes).
  const ytSource = (() => {
    const m = show?.sourceRef?.match(/^(channel|playlist):(.+)$/)
    return m ? { kind: m[1] as 'channel' | 'playlist', id: m[2]! } : null
  })()

  async function handleNextBatch() {
    if (!ytSource) return
    setBatching(true)
    try {
      const src = ytSource.kind === 'channel' ? (await getChannelPage(ytSource.id)).videos : (await getPlaylist(ytSource.id)).videos
      const vids = src.map(v => ({ videoId: v.videoId, title: v.title ?? undefined, author: v.author ?? undefined }))
      const res = await createPodcast(vids.slice(0, 100), { showId: id, limit: getBatchSize() })
      if (res.error) { toast.error(res.error); return }
      const n = res.episodeCount ?? 0
      if (n === 0) { toast.info('Every video from this source is already an episode.'); return }
      toast.success(`${n} more ${n === 1 ? 'episode' : 'episodes'} queued${res.remaining ? ` · ${res.remaining} left` : ''}.`)
      await qc.invalidateQueries({ queryKey: ['podcast-episodes', id] })
    } catch {
      toast.error('Could not generate the next batch.')
    } finally {
      setBatching(false)
    }
  }

  async function handleDeleteShow() {
    if (!show) return
    await deleteShow(show.id)
    closeIfShow(show.id)
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['podcast-shows'] }),
      qc.invalidateQueries({ queryKey: ['podcast-feed'] }),
    ])
    navigate('/podcasts/library')
  }

  if (!show) {
    return (
      <div className="px-6 py-20 text-center text-sm text-muted-foreground">
        Show not found. <Link to="/podcasts/library" className="text-brand hover:underline">Back to Library</Link>
      </div>
    )
  }

  const hostNames = show.hosts
    .map(h => characters.find(c => c.id === h.characterId)?.name)
    .filter(Boolean) as string[]

  return (
    <div className="mx-auto max-w-5xl px-6 py-7 pb-24">
      {/* Breadcrumb */}
      <nav className="mb-5 flex items-center gap-1.5 text-sm">
        <Link to="/podcasts/library" className="text-muted-foreground hover:text-foreground">Library</Link>
        <ChevronRight className="size-3.5 text-muted-foreground/50" />
        <span className="font-medium">{show.name}</span>
      </nav>

      {/* Header */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <ShowCover showId={show.id} title={show.name} size={160} rounded="rounded-2xl" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-black tracking-tight">{show.name}</h1>
              <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-[11px] font-semibold text-brand">
                <Sparkles className="size-3" /> AI Generated
              </span>
            </div>
            {show.isOwn && (
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={() => openEdit(show)} className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted">
                  <Pencil className="size-3.5" /> Edit Show
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="More">
                      <MoreHorizontal className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => openEdit(show)}><Pencil className="size-4" /> Edit Show</DropdownMenuItem>
                    <DropdownMenuItem disabled={anyGenerating} onSelect={() => void handleGenerate()}><Plus className="size-4" /> New Episode</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDeleteShow(true)}><Trash2 className="size-4" /> Delete Show</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
          {show.description && <p className="mt-2 max-w-2xl text-sm text-muted-foreground leading-relaxed">{show.description}</p>}
          <StingerAudition showId={show.id} />
          {isYouTube && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Video className="size-4 text-red-500" /> Generated from your YouTube content
            </p>
          )}
          {!show.isOwn && <p className="mt-1 text-xs text-muted-foreground">by {show.ownerName}</p>}
        </div>
      </div>

      {/* Stats */}
      <div className="mt-6 flex flex-wrap items-center gap-x-10 gap-y-3 rounded-2xl border border-border/40 bg-card px-5 py-4">
        <Stat value={String(episodes.length)} label="Episodes" />
        <Stat value={fmtTotalRuntime(totalRuntime) || '—'} label="Total Runtime" />
        <Stat value={fmtDate(show.createdAt) || '—'} label="Created" />
      </div>

      {/* Tabs */}
      <div className="mt-6 flex gap-6 border-b border-border/40">
        {([['episodes', 'Episodes'], ['about', 'About']] as const).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)}
            className={cn('-mb-px border-b-2 pb-2.5 text-sm font-semibold transition-colors',
              tab === t ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'episodes' ? (
        <div className="mt-5">
          {/* Toolbar */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {show.isOwn && (
              <>
                {ytSource && (
                  <button onClick={handleNextBatch} disabled={batching || anyGenerating}
                    title={anyGenerating ? 'Wait for the current episodes to finish generating' : undefined}
                    className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-brand-foreground hover:opacity-90 disabled:opacity-50">
                    {(batching || anyGenerating) ? <Loader2 className="size-4 animate-spin" /> : <ListPlus className="size-4" />} {anyGenerating && !batching ? 'Generating…' : 'Generate next batch'}
                  </button>
                )}
                <button onClick={handleGenerate} disabled={generating || anyGenerating}
                  title={anyGenerating ? 'Wait for the current episodes to finish generating' : undefined}
                  className={cn('flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50',
                    ytSource ? 'border border-border font-medium hover:bg-muted' : 'bg-brand text-brand-foreground hover:opacity-90')}>
                  {generating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Create Episode
                </button>
                {!ytSource && (
                  <button onClick={() => navigate('/youtube')}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted">
                    <Video className="size-4 text-red-500" /> Import from YouTube
                  </button>
                )}
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => setSortNewest(v => !v)} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-xs font-medium text-muted-foreground hover:bg-muted">
                <ArrowUpDown className="size-3.5" /> {sortNewest ? 'Newest' : 'Oldest'}
              </button>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search episodes..."
                  className="w-44 rounded-lg border border-border bg-background py-2 pl-8 pr-2 text-sm outline-none focus:ring-2 focus:ring-brand" />
              </div>
            </div>
          </div>

          {isLoading ? (
            <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-card/50" />)}</div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <Radio className="size-9 opacity-30" />
              <p className="text-sm">{query ? 'No episodes match.' : 'No episodes yet.'}</p>
              {show.isOwn && !query && <p className="text-xs">Click Create Episode to generate your first one.</p>}
            </div>
          ) : (
            <div className="space-y-1">
              {visible.map(ep => {
                const ri = readyTracks.findIndex(t => t.episodeId === ep.id)
                return (
                  <EpisodeRow key={ep.id} episode={ep} show={{ id, name: show.name }} canManage={show.isOwn}
                    playlist={ri >= 0 ? { tracks: readyTracks, index: ri } : undefined} />
                )
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-5 space-y-5 text-sm">
          <Detail label="Description">{show.description || 'No description.'}</Detail>
          <Detail label="Format"><span className="capitalize">{show.style}</span></Detail>
          {hostNames.length > 0 && <Detail label="Hosts">{hostNames.join(', ')}</Detail>}
          <Detail label="Content Sources">{show.segments.map(s => s.type).join(', ') || 'None'}</Detail>
          <Detail label="Visibility">{show.visibility === 'shared' ? 'Shared with family' : 'Private'}</Detail>
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteShow}
        onOpenChange={setConfirmDeleteShow}
        title="Delete show"
        description={`Delete "${show.name}" and all its episodes? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleDeleteShow()}
      />
    </div>
  )
}

/** Compact intro/outro audition. Hides itself when the show has no stinger. */
function StingerAudition({ showId }: { showId: string }) {
  const [exists, setExists] = useState(false)
  const [playing, setPlaying] = useState<'intro' | 'outro' | null>(null)
  const ref = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    fetch(stingerUrl(showId, 'intro'), { credentials: 'include', signal: ac.signal })
      .then(r => { setExists(r.ok); ac.abort() })  // abort after headers — don't download the clip
      .catch(() => {})
    return () => ac.abort()
  }, [showId])

  if (!exists) return null

  const play = (part: 'intro' | 'outro') => {
    const el = ref.current; if (!el) return
    if (playing === part) { el.pause(); setPlaying(null); return }
    el.src = stingerUrl(showId, part)
    el.play().then(() => setPlaying(part)).catch(() => setPlaying(null))
  }

  return (
    <div className="mt-3 flex items-center gap-2">
      <Music className="size-3.5 text-muted-foreground" />
      {(['intro', 'outro'] as const).map(part => (
        <button key={part} onClick={() => play(part)}
          className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs font-medium capitalize text-muted-foreground hover:bg-muted hover:text-foreground">
          {playing === part ? <Pause className="size-3" /> : <Play className="size-3" />} {part}
        </button>
      ))}
      <audio ref={ref} className="hidden" onEnded={() => setPlaying(null)} />
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <p className="text-xl font-bold leading-none">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 border-b border-border/40 pb-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  )
}
