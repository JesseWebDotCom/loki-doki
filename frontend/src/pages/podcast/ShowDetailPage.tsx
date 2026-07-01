import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight, Pencil, Sparkles, Video, Plus, Search, Loader2, Radio, ArrowUpDown,
  MoreHorizontal, Trash2, ListPlus, Music, Play, Pause, Download, Clock, AlertCircle,
  Check, RotateCw,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { createPodcast, getChannelPage, getPlaylist } from '@/lib/youtube/api'
import { getBatchSize } from '@/lib/youtube/podcast'
import { ShowCover } from '@/components/podcast/ShowCover'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { usePodcastUI } from '@/components/podcast/PodcastLayout'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  getShows, getEpisodes, getEpisodeDetail, generateEpisode, deleteShow, updateShow,
  getHostCharacters, regenerateEpisode, deleteEpisode, toTrack,
  stingerUrl, type Episode, type EpisodeDetail, type EpisodeSource,
} from '@/lib/podcast/api'
import { fmtDate, fmtDuration, fmtTime } from '@/lib/podcast/format'
import { Switch } from '@/components/ui/switch'

export function ShowDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { openEdit } = usePodcastUI()
  const { closeIfShow, track, playing, positionSec, duration, pause, resume, seek, play, playQueue, enqueue } = usePodcastPlayback()

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
  const anyGenerating = episodes.some(e => e.status === 'generating' || e.status === 'pending')
  const isYouTube = show?.segments?.some(s => s.type === 'youtube') || show?.source === 'app'

  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? episodes.filter(e => e.title.toLowerCase().includes(q)) : episodes
    const ts = (e: Episode) => new Date(e.generatedAt ?? e.createdAt ?? 0).getTime()
    return [...list].sort((a, b) => sortNewest ? ts(b) - ts(a) : ts(a) - ts(b))
  }, [episodes, query, sortNewest])

  const readyTracks = ready.map(e => toTrack(e, { id, name: show?.name ?? '' }))

  // Which episode's transcript is shown in the left panel.
  // Defaults to the currently playing episode from this show, else the first ready one.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const effectiveSelectedId = selectedId
    ?? (track?.showId === id ? track.episodeId : null)
    ?? sorted.find(e => e.status === 'ready')?.id
    ?? null
  const selectedEp = episodes.find(e => e.id === effectiveSelectedId) ?? null

  // Sync selection when playback changes to an ep from this show.
  useEffect(() => {
    if (track?.showId === id) setSelectedId(track.episodeId)
  }, [track?.episodeId, track?.showId, id])

  // Load transcript for the selected episode.
  const [detail, setDetail] = useState<EpisodeDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  useEffect(() => {
    setDetail(null)
    if (!effectiveSelectedId) return
    let alive = true
    setDetailLoading(true)
    getEpisodeDetail(effectiveSelectedId)
      .then(d => { if (alive) setDetail(d) })
      .catch(() => {})
      .finally(() => { if (alive) setDetailLoading(false) })
    return () => { alive = false }
  }, [effectiveSelectedId])

  const ytSource = (() => {
    const m = show?.sourceRef?.match(/^(channel|playlist):(.+)$/)
    return m ? { kind: m[1] as 'channel' | 'playlist', id: m[2]! } : null
  })()

  async function handleGenerate() {
    setGenerating(true)
    try {
      await generateEpisode(id)
      await qc.invalidateQueries({ queryKey: ['podcast-episodes', id] })
    } finally { setGenerating(false) }
  }

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

  const [autoGen, setAutoGen] = useState(false)
  useEffect(() => { setAutoGen(!!show?.autoGenerate) }, [show?.autoGenerate])

  async function toggleAutoGen(v: boolean) {
    setAutoGen(v)
    try {
      await updateShow(id, { autoGenerate: v })
      await qc.invalidateQueries({ queryKey: ['podcast-shows'] })
      toast.success(v ? 'New videos will become episodes automatically.' : 'Auto-generate turned off.')
    } catch {
      setAutoGen(!v)
      toast.error('Could not update auto-generate.')
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

  function downloadTranscript() {
    if (!detail || !selectedEp) return
    const header = [
      'PODCAST TRANSCRIPT',
      `Show: ${show?.name ?? ''}`,
      `Episode: ${selectedEp.title}`,
      selectedEp.generatedAt ? `Date: ${fmtDate(selectedEp.generatedAt)}` : '',
    ].filter(Boolean).join('\n')
    const body = detail.transcript.map(t => `${t.speaker.toUpperCase()}\n${t.text}`).join('\n\n')
    const text = `${header}\n\n${'─'.repeat(40)}\n\n${body}`
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedEp.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-transcript.txt`
    a.click()
    URL.revokeObjectURL(url)
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

  const sourceBackLink = (() => {
    const ref = show.sourceRef ?? ''
    const tvM = ref.match(/^tvshow:(\d+)$/)
    if (tvM) return { url: `/shows/${tvM[1]}`, label: 'TV Show' }
    const movM = ref.match(/^movie:(.+)$/)
    if (movM) return { url: `/movies/${encodeURIComponent(movM[1])}`, label: movM[1].replace(/\b\w/g, c => c.toUpperCase()) }
    const chM = ref.match(/^channel:(.+)$/)
    if (chM) return { url: `/youtube/channel/${chM[1]}`, label: 'YouTube Channel' }
    return null
  })()

  const isCurrent = track?.episodeId === effectiveSelectedId
  const total = isCurrent ? (track?.durationSec || duration || 0) : (selectedEp?.durationSec ?? 0)
  const pos = isCurrent ? positionSec : 0

  // Position of selected episode in the sorted list (1-based), for "Episode N of M" label.
  const selectedEpIndex = effectiveSelectedId ? sorted.findIndex(e => e.id === effectiveSelectedId) : -1
  const selectedEpNumber = selectedEpIndex >= 0 ? selectedEpIndex + 1 : null

  return (
    <div className="flex min-h-screen">
      {/* ── Left column: show header + episode detail + transcript ── */}
      <div className="min-w-0 flex-1">
        <div className="px-6 py-6 pb-24">

          {/* Back nav */}
          <Link to="/podcasts/library" className="mb-5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 rotate-180" /> Library
          </Link>

          {/* Show header — always visible */}
          <div className="mb-8 flex gap-5">
            {/* Cover — clickable to edit for owners */}
            <div className="relative shrink-0">
              <ShowCover showId={show.id} title={show.name} size={160} rounded="rounded-2xl" />
              {show.isOwn && (
                <button onClick={() => openEdit(show)}
                  className="absolute inset-0 flex items-end justify-center rounded-2xl bg-black/0 opacity-0 transition-all hover:bg-black/40 hover:opacity-100 pb-2">
                  <span className="flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 text-[10px] font-semibold text-white">
                    <Pencil className="size-2.5" /> Edit
                  </span>
                </button>
              )}
            </div>

            <div className="min-w-0 flex-1 pt-1">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">AI Podcast</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold capitalize text-muted-foreground">{show.style}</span>
              </div>
              <h1 className="text-3xl font-black leading-tight tracking-tight">{show.name}</h1>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span>{episodes.length} {episodes.length === 1 ? 'episode' : 'episodes'}</span>
                {hostNames.length > 0 && <span>· Hosted by {hostNames.join(', ')}</span>}
                {sourceBackLink && (
                  <span>· <Link to={sourceBackLink.url} className="hover:text-foreground hover:underline">← {sourceBackLink.label}</Link></span>
                )}
              </div>

              {show.description && (
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{show.description}</p>
              )}

              <div className="mt-4 flex items-center gap-2">
                {show.isOwn && (
                  <>
                    <button onClick={() => openEdit(show)}
                      className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted">
                      <Pencil className="size-3.5" /> Edit Show
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground">
                          <MoreHorizontal className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem disabled={anyGenerating} onSelect={() => void handleGenerate()}><Plus className="size-4" /> New Episode</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDeleteShow(true)}><Trash2 className="size-4" /> Delete Show</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
                {!show.isOwn && show.ownerName && (
                  <p className="text-xs text-muted-foreground">by {show.ownerName}</p>
                )}
              </div>
            </div>
          </div>

          {/* Divider between show info and selected episode */}
          {effectiveSelectedId && <div className="mb-6 border-t border-border/40" />}

          {/* Episode detail + transcript */}
          {!effectiveSelectedId ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center text-muted-foreground">
              <Radio className="size-10 opacity-25" />
              <p className="text-sm">No episodes yet.</p>
              {show.isOwn && <p className="text-xs">Use the panel on the right to generate your first episode.</p>}
            </div>
          ) : selectedEp ? (
            <>
              {/* Episode title + meta */}
              <div className="mb-5">
                <p className={cn('text-xs font-semibold uppercase tracking-widest mb-1',
                  selectedEp.status === 'generating' ? 'text-brand' : 'text-muted-foreground/60')}>
                  {selectedEp.status === 'generating' ? 'Generating…'
                    : selectedEp.status === 'pending' ? 'Queued'
                    : selectedEpNumber != null ? `Episode ${selectedEpNumber} of ${sorted.length}` : 'Episode'}
                </p>
                <h2 className="text-2xl font-black leading-snug tracking-tight">{selectedEp.title}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
                  {selectedEp.generatedAt && <span>{fmtDate(selectedEp.generatedAt)}</span>}
                  {selectedEp.durationSec ? <span>· {fmtDuration(selectedEp.durationSec)}</span> : null}
                </div>
                {selectedEp.description && (
                  <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{selectedEp.description}</p>
                )}
              </div>

              {/* Transport — shown when this episode is the active track */}
              {isCurrent && selectedEp.status === 'ready' && (
                <div className="mb-6 rounded-2xl border border-border/40 bg-card p-4">
                  <div className="flex items-center gap-3">
                    <button onClick={playing ? pause : resume}
                      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground hover:opacity-90">
                      {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current ml-0.5" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <input
                        type="range" min={0} max={total || 100} step={1} value={pos}
                        onChange={e => seek(Number(e.target.value))}
                        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-muted accent-brand"
                      />
                      <div className="mt-1 flex justify-between text-xs tabular-nums text-muted-foreground">
                        <span>{fmtTime(pos)}</span>
                        <span>-{fmtTime(Math.max(0, total - pos))}</span>
                      </div>
                    </div>
                    <button onClick={() => enqueue(toTrack(selectedEp, { id, name: show.name }))} title="Add to Up Next"
                      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
                      <ListPlus className="size-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* Play button when not currently active */}
              {!isCurrent && selectedEp.status === 'ready' && (
                <div className="mb-4">
                  <button
                    onClick={() => {
                      const ri = readyTracks.findIndex(t => t.episodeId === selectedEp.id)
                      if (ri >= 0) playQueue(readyTracks, ri, selectedEp.watchState?.positionSec ?? 0)
                      else play(toTrack(selectedEp, { id, name: show.name }), selectedEp.watchState?.positionSec ?? 0)
                    }}
                    className="flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground hover:opacity-90">
                    <Play className="size-4 fill-current" /> Play Episode
                  </button>
                </div>
              )}

              {/* Source pills — compact, below play button */}
              {detail && detail.sources.length > 0 && (
                <SourcePills sources={detail.sources} />
              )}

              {/* Transcript */}
              <div>
                <div className="mb-3 flex items-center gap-3">
                  <h3 className="text-base font-bold">Transcript</h3>
                  {detail && detail.transcript.length > 0 && (
                    <>
                      <span className="text-xs text-muted-foreground">{detail.transcript.length} turns</span>
                      <button onClick={downloadTranscript}
                        className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                        <Download className="size-3.5" /> Download
                      </button>
                    </>
                  )}
                </div>

                {detailLoading ? (
                  <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Loading transcript…
                  </div>
                ) : !detail || detail.transcript.length === 0 ? (
                  <p className="py-8 text-sm text-muted-foreground">
                    {selectedEp.status === 'ready'
                      ? 'No transcript available for this episode.'
                      : 'Transcript will be available once the episode finishes generating.'}
                  </p>
                ) : (
                  <div className="space-y-4">
                    {detail.transcript.map((t, i) => (
                      <div key={i}>
                        <p className="mb-0.5 text-xs font-semibold text-brand">{t.speaker}</p>
                        <p className="text-sm leading-relaxed text-muted-foreground">{t.text}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}
        </div>
      </div>

      {/* ── Right column: episode playlist sidebar ── */}
      <aside className="w-80 shrink-0 border-l border-border/40 xl:w-96">
        <div className="sticky top-0 flex h-screen flex-col">
          {/* Sidebar header */}
          <div className="border-b border-border/40 p-4 pb-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">Episodes</p>
            <p className="mt-0.5 font-bold">{show.name}</p>
            {isYouTube && (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <Video className="size-3.5 text-red-500" /> From YouTube
              </p>
            )}
            <StingerAudition showId={show.id} />
          </div>

          {/* Generate actions */}
          {show.isOwn && (
            <div className="flex flex-wrap gap-1.5 border-b border-border/40 px-4 py-3">
              {ytSource && (
                <button onClick={handleNextBatch} disabled={batching || anyGenerating}
                  className="flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-brand-foreground hover:opacity-90 disabled:opacity-50">
                  {(batching || anyGenerating) ? <Loader2 className="size-3 animate-spin" /> : <ListPlus className="size-3" />}
                  {anyGenerating && !batching ? 'Generating…' : 'Next batch'}
                </button>
              )}
              <button onClick={handleGenerate} disabled={generating || anyGenerating}
                className={cn('flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50',
                  ytSource ? 'border border-border hover:bg-muted' : 'bg-brand text-brand-foreground hover:opacity-90')}>
                {generating ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />} Create
              </button>
              {ytSource && (
                <label className={cn('flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                  autoGen ? 'border-brand/40 bg-brand/10 text-brand' : 'border-border text-muted-foreground hover:bg-muted')}>
                  <Sparkles className="size-3" /> Auto
                  <Switch checked={autoGen} onCheckedChange={v => void toggleAutoGen(v)} className="scale-75" />
                </label>
              )}
              {!ytSource && (
                <button onClick={() => navigate('/youtube')}
                  className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted">
                  <Video className="size-3 text-red-500" /> Import YouTube
                </button>
              )}
            </div>
          )}

          {/* Sort + search */}
          <div className="flex items-center gap-1.5 border-b border-border/40 px-4 py-2.5">
            <button onClick={() => setSortNewest(v => !v)}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted">
              <ArrowUpDown className="size-3" /> {sortNewest ? 'Newest' : 'Oldest'}
            </button>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/50" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search…"
                className="w-full rounded-md border border-border bg-background py-1 pl-6 pr-2 text-xs outline-none focus:ring-1 focus:ring-brand" />
            </div>
          </div>

          {/* Episode list */}
          <div className="flex-1 overflow-y-auto py-1">
            {isLoading ? (
              <div className="space-y-1 p-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-12 animate-pulse rounded-lg bg-muted/50" />
                ))}
              </div>
            ) : sorted.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
                <Radio className="size-7 opacity-25" />
                <p className="text-xs">{query ? 'No matches.' : 'No episodes yet.'}</p>
              </div>
            ) : (
              sorted.map((ep, i) => (
                <SidebarEpisodeRow
                  key={ep.id}
                  episode={ep}
                  show={{ id, name: show.name }}
                  index={i + 1}
                  isSelected={ep.id === effectiveSelectedId}
                  canManage={show.isOwn}
                  readyTracks={readyTracks}
                  onSelect={() => setSelectedId(ep.id)}
                  onInvalidate={async () => { await qc.invalidateQueries({ queryKey: ['podcast-episodes', id] }) }}
                />
              ))
            )}
          </div>

        </div>
      </aside>

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

/** Compact sidebar episode row — like a YouTube playlist item. */
function SidebarEpisodeRow({ episode, show, index, isSelected, canManage, readyTracks, onSelect, onInvalidate }: {
  episode: Episode
  show: { id: string; name: string }
  index: number
  isSelected: boolean
  canManage: boolean
  readyTracks: ReturnType<typeof toTrack>[]
  onSelect: () => void
  onInvalidate: () => Promise<void>
}) {
  const { track, playing, play, playQueue, enqueue, pause, resume, close } = usePodcastPlayback()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isCurrent = track?.episodeId === episode.id
  const ready = episode.status === 'ready'
  const progress = episode.watchState
  const pct = progress && episode.durationSec ? Math.min(100, (progress.positionSec / episode.durationSec) * 100) : 0

  function handlePlay(e: React.MouseEvent) {
    e.stopPropagation()
    if (isCurrent) { playing ? pause() : resume(); return }
    const ri = readyTracks.findIndex(t => t.episodeId === episode.id)
    if (ri >= 0) playQueue(readyTracks, ri, progress?.positionSec ?? 0)
    else play(toTrack(episode, show), progress?.positionSec ?? 0)
    onSelect()
  }

  async function handleDelete() {
    if (isCurrent) close()
    await deleteEpisode(episode.id)
    await onInvalidate()
  }

  return (
    <>
      <div
        onClick={onSelect}
        className={cn(
          'group relative flex cursor-pointer items-center gap-2 px-4 py-2.5 transition-colors hover:bg-accent/40',
          isSelected && 'bg-accent/40',
        )}
      >
        {/* Index / play indicator */}
        <div className="relative flex w-6 shrink-0 items-center justify-center">
          <span className={cn('text-[11px] tabular-nums transition-opacity',
            isCurrent ? 'text-brand' : 'text-muted-foreground',
            ready ? 'group-hover:opacity-0' : '')}>
            {isCurrent ? '▶' : index}
          </span>
          {ready && (
            <button onClick={handlePlay}
              className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
              tabIndex={-1}>
              {isCurrent && playing
                ? <Pause className="size-3 fill-current text-brand" />
                : <Play className="size-3 fill-current text-brand ml-0.5" />}
            </button>
          )}
        </div>

        {/* Title + meta */}
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-xs font-semibold leading-snug',
            isCurrent ? 'text-brand' : 'text-foreground/90')}>
            {episode.title}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0">
            {episode.generatedAt && (
              <span className="text-[10px] text-muted-foreground">{fmtDate(episode.generatedAt)}</span>
            )}
            {episode.durationSec ? (
              <span className="text-[10px] text-muted-foreground">· {fmtDuration(episode.durationSec)}</span>
            ) : null}
            {episode.status === 'generating' && (
              <span className="flex items-center gap-0.5 text-[10px] text-brand">
                <Loader2 className="size-2.5 animate-spin" /> Generating
              </span>
            )}
            {episode.status === 'pending' && <span className="text-[10px] text-muted-foreground">Queued</span>}
            {episode.status === 'failed' && (
              <span className="flex items-center gap-0.5 text-[10px] text-destructive">
                <AlertCircle className="size-2.5" /> Failed
              </span>
            )}
            {progress?.completed && (
              <span className="flex items-center gap-0.5 text-[10px] text-emerald-500">
                <Check className="size-2.5" /> Played
              </span>
            )}
          </div>
          {pct > 0 && !progress?.completed && (
            <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>

        {/* Non-ready status icon */}
        {!ready && (
          <div className="shrink-0 text-muted-foreground">
            {episode.status === 'generating' ? <Loader2 className="size-3.5 animate-spin text-brand" />
              : episode.status === 'failed' ? <AlertCircle className="size-3.5 text-destructive" />
              : <Clock className="size-3.5" />}
          </div>
        )}

        {/* Context menu */}
        {(ready || canManage) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
              <button className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100">
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {ready && <DropdownMenuItem onSelect={e => handlePlay(e as unknown as React.MouseEvent)}><Play className="size-4" /> Play</DropdownMenuItem>}
              {ready && <DropdownMenuItem onSelect={() => enqueue(toTrack(episode, show))}><ListPlus className="size-4" /> Add to Up Next</DropdownMenuItem>}
              {canManage && (
                <>
                  {ready && <DropdownMenuSeparator />}
                  <DropdownMenuItem onSelect={async () => { await regenerateEpisode(episode.id); await onInvalidate() }}>
                    <RotateCw className="size-4" /> Regenerate
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                    <Trash2 className="size-4" /> Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete episode"
        description={`Delete "${episode.title}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleDelete()}
      />
    </>
  )
}

function SourcePills({ sources }: { sources: EpisodeSource[] }) {
  const [expanded, setExpanded] = useState(false)
  const PREVIEW = 4
  const shown = expanded || sources.length <= PREVIEW ? sources : sources.slice(0, PREVIEW)
  const hidden = sources.length - PREVIEW

  function sourceHref(src: EpisodeSource): string {
    if (src.sourceType === 'youtube') return `/youtube/watch/${src.sourceId}`
    if (src.sourceType === 'tvshow') return `/shows/${src.sourceId}`
    return `/movies/${encodeURIComponent(src.sourceId)}`
  }
  function sourceIcon(src: EpisodeSource) {
    if (src.sourceType === 'youtube') return <Video className="size-3 text-red-500" />
    return <Video className="size-3 text-muted-foreground" />
  }

  return (
    <div className="mb-5">
      <p className="mb-2 text-xs font-medium text-muted-foreground">Sources</p>
      <div className="flex flex-wrap gap-2">
        {shown.map((src, i) => (
          <Link key={i} to={sourceHref(src)}
            className="flex max-w-xs items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-accent hover:text-foreground">
            {sourceIcon(src)}
            <span className="truncate">{src.title ?? (src.sourceType === 'youtube' ? 'Watch video' : src.sourceId)}</span>
          </Link>
        ))}
        {!expanded && hidden > 0 && (
          <button onClick={() => setExpanded(true)}
            className="rounded-full border border-border/60 bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            +{hidden} more
          </button>
        )}
      </div>
    </div>
  )
}

function StingerAudition({ showId }: { showId: string }) {
  const [exists, setExists] = useState(false)
  const [playing, setPlaying] = useState<'intro' | 'outro' | null>(null)
  const ref = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const ac = new AbortController()
    fetch(stingerUrl(showId, 'intro'), { credentials: 'include', signal: ac.signal })
      .then(r => { setExists(r.ok); ac.abort() })
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
    <div className="mt-2 flex items-center gap-1.5">
      <Music className="size-3 text-muted-foreground" />
      {(['intro', 'outro'] as const).map(part => (
        <button key={part} onClick={() => play(part)}
          className="flex items-center gap-0.5 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium capitalize text-muted-foreground hover:bg-muted hover:text-foreground">
          {playing === part ? <Pause className="size-2.5" /> : <Play className="size-2.5" />} {part}
        </button>
      ))}
      <audio ref={ref} className="hidden" onEnded={() => setPlaying(null)} />
    </div>
  )
}
