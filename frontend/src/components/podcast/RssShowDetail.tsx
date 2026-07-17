import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronRight, Play, Pause,
  RotateCw, Rss, ExternalLink, ArrowDownToLine, AlertCircle, Check, ListPlus, ListStart,
  Settings2, Trash2, SlidersHorizontal, Bookmark,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { PageContainer } from '@/components/shared/PageContainer'
import { ShowCover } from '@/components/podcast/ShowCover'
import {
  EPISODE_PAGE_SIZE, ShowHero, EpisodesToolbar, EpisodeListSkeleton, EpisodeEmptyState,
  ShowMoreButton, EpisodeRowFrame, EpisodeRowTitle, EpisodeRowMeta, EpisodeRowDescription,
} from '@/components/podcast/ShowDetailParts'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import {
  coverUrl, getEpisodes, toTrack, refreshSubscription, unsubscribePodcast, updateSubscription,
  downloadEpisode, removeEpisodeDownload,
  type Episode, type Show,
} from '@/lib/podcast/api'
import { getBookmarks } from '@/lib/podcast/playerApi'
import { ShowPlaybackSettings } from '@/components/podcast/ShowPlaybackSettings'
import { BookmarkRow } from '@/components/podcast/BookmarkRow'
import { PodcastCredits, PodcastFundingLink, PodcastHighlights } from '@/components/podcast/PodcastCredits'
import { fmtDate, fmtDuration } from '@/lib/podcast/format'

const PAGE_SIZE = EPISODE_PAGE_SIZE

/** Detail page for a subscribed RSS podcast - Apple-Podcasts-style hero + episode list. */
export function RssShowDetail({ show }: { show: Show }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { closeIfShow, track, playing, pause, resume, playQueue } = usePodcastPlayback()

  const [query, setQuery] = useState('')
  const [sortNewest, setSortNewest] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [confirmUnsubscribe, setConfirmUnsubscribe] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [playbackSettingsOpen, setPlaybackSettingsOpen] = useState(false)

  const { data: episodes = [], isLoading } = useQuery({
    queryKey: ['podcast-episodes', show.id],
    queryFn: () => getEpisodes(show.id),
    // Poll while an offline download is in flight.
    refetchInterval: q => (q.state.data?.some((e: Episode) =>
      e.download?.status === 'pending' || e.download?.status === 'downloading') ? 4000 : false),
  })

  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q ? episodes.filter(e => e.title.toLowerCase().includes(q)) : episodes
    const ts = (e: Episode) => new Date(e.publishedAt ?? e.createdAt ?? 0).getTime()
    return [...list].sort((a, b) => sortNewest ? ts(b) - ts(a) : ts(a) - ts(b))
  }, [episodes, query, sortNewest])

  // Reset paging when the list changes shape.
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [query, sortNewest, show.id])

  const readyTracks = useMemo(
    () => sorted.filter(e => e.status === 'ready').map(e => toTrack(e, { id: show.id, name: show.name })),
    [sorted, show.id, show.name],
  )

  const latest = useMemo(() => {
    const ts = (e: Episode) => new Date(e.publishedAt ?? e.createdAt ?? 0).getTime()
    return [...episodes].filter(e => e.status === 'ready').sort((a, b) => ts(b) - ts(a))[0] ?? null
  }, [episodes])
  const latestIsCurrent = latest != null && track?.episodeId === latest.id

  function playEpisode(ep: Episode) {
    const i = readyTracks.findIndex(t => t.episodeId === ep.id)
    const startAt = ep.watchState?.positionSec ?? 0
    if (i >= 0) playQueue(readyTracks, i, startAt)
  }

  function handlePlayLatest() {
    if (!latest) return
    if (latestIsCurrent) { playing ? pause() : resume(); return }
    playEpisode(latest)
  }

  async function handleRefreshFeed() {
    setRefreshing(true)
    try {
      const added = await refreshSubscription(show.id)
      if (added > 0) toast.success(`+${added} new ${added === 1 ? 'episode' : 'episodes'}`)
      else toast.info('No new episodes.')
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['podcast-episodes', show.id] }),
        qc.invalidateQueries({ queryKey: ['podcast-feed'] }),
      ])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not refresh the feed.')
    } finally {
      setRefreshing(false)
    }
  }

  async function handleUnsubscribe() {
    try {
      await unsubscribePodcast(show.id)
      closeIfShow(show.id)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['podcast-shows'] }),
        qc.invalidateQueries({ queryKey: ['podcast-feed'] }),
        qc.invalidateQueries({ queryKey: ['podcast-subscriptions'] }),
      ])
      navigate('/podcasts')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not unsubscribe.')
    }
  }

  const visible = sorted.slice(0, visibleCount)

  return (
    <PageContainer width="narrow" className="py-6 pb-24">
      {/* Back nav */}
      <Link to="/podcasts/library" className="mb-5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 rotate-180" /> Library
      </Link>

      {/* ── Hero ── */}
      <ShowHero
        art={coverUrl(show.id)}
        cover={<ShowCover showId={show.id} title={show.name} size={176} rounded="rounded-card" />}
        badges={show.categories}
        title={show.name}
        author={show.author}
        meta={<>
          <span>{episodes.length} {episodes.length === 1 ? 'episode' : 'episodes'}</span>
          {show.link && (
            <span>· <a href={show.link} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-0.5 hover:text-foreground hover:underline">
              Website <ExternalLink className="size-3" />
            </a></span>
          )}
        </>}
        description={show.description}
        warning={show.feedError ? (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
            <AlertCircle className="size-3.5" /> Feed issue: {show.feedError}
          </p>
        ) : null}
        actions={<>
          <Button onClick={handlePlayLatest} disabled={!latest} className="gap-2 font-semibold">
            {latestIsCurrent && playing
              ? <><Pause className="size-4 fill-current" /> Pause</>
              : <><Play className="size-4 fill-current" /> {latestIsCurrent ? 'Resume' : 'Play Latest'}</>}
          </Button>

          <Button variant="outline" size="icon" onClick={() => void handleRefreshFeed()} disabled={refreshing}
            title="Refresh feed" aria-label="Refresh feed" className="text-muted-foreground hover:text-foreground">
            {refreshing ? <Spinner className="text-current" /> : <RotateCw className="size-4" />}
          </Button>

          {/* Podcasting 2.0: the show's own support link, when the feed publishes one. */}
          <PodcastFundingLink funding={show.funding} />

          {show.subscription && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" title="Podcast settings" aria-label="Podcast settings"
                  className="text-muted-foreground hover:text-foreground">
                  <Settings2 className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuItem onSelect={() => setPlaybackSettingsOpen(true)}>
                  <SlidersHorizontal className="size-4" /> Playback settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <AutoDownloadSettings showId={show.id} subscription={show.subscription} />
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmUnsubscribe(true)}>
                  <Rss className="size-4" /> Unsubscribe
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>}
      />

      {/* ── Podcasting 2.0 person credits (renders nothing when the feed has none) ── */}
      <PodcastCredits persons={show.persons} title="Who makes this" className="mb-6" />

      {/* ── Bookmarks in this show ── */}
      <ShowBookmarksSection showId={show.id} />

      {/* ── Episode list ── */}
      <EpisodesToolbar
        count={sorted.length}
        sortNewest={sortNewest}
        onToggleSort={() => setSortNewest(v => !v)}
        query={query}
        onQueryChange={setQuery}
      />

      {isLoading ? (
        <EpisodeListSkeleton />
      ) : sorted.length === 0 ? (
        <EpisodeEmptyState
          primary={query ? 'No episodes match your search.' : 'No episodes yet.'}
          secondary={query ? undefined : 'Try refreshing the feed.'}
        />
      ) : (
        <>
          <div className="divide-y divide-border/30">
            {visible.map(ep => (
              <RssEpisodeRow
                key={ep.id}
                episode={ep}
                show={show}
                readyTracks={readyTracks}
                onPlay={() => playEpisode(ep)}
                expanded={expandedId === ep.id}
                onToggle={() => setExpandedId(cur => cur === ep.id ? null : ep.id)}
                onInvalidate={async () => { await qc.invalidateQueries({ queryKey: ['podcast-episodes', show.id] }) }}
              />
            ))}
          </div>
          {visibleCount < sorted.length && (
            <ShowMoreButton remaining={sorted.length - visibleCount} onClick={() => setVisibleCount(v => v + PAGE_SIZE)} />
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmUnsubscribe}
        onOpenChange={setConfirmUnsubscribe}
        title="Unsubscribe"
        description={`Unsubscribe from "${show.name}"? Your downloaded episodes will be removed.`}
        confirmLabel="Unsubscribe"
        destructive
        onConfirm={() => void handleUnsubscribe()}
      />

      <ShowPlaybackSettings showId={show.id} showName={show.name} open={playbackSettingsOpen} onOpenChange={setPlaybackSettingsOpen} />
    </PageContainer>
  )
}

/** Bookmarked moments across this show's episodes - collapsed to a short list. */
function ShowBookmarksSection({ showId }: { showId: string }) {
  const qc = useQueryClient()
  const [showAll, setShowAll] = useState(false)
  const { data: bookmarks = [] } = useQuery({
    queryKey: ['podcast-bookmarks', showId],
    queryFn: () => getBookmarks({ showId }),
  })
  if (bookmarks.length === 0) return null
  const visible = showAll ? bookmarks : bookmarks.slice(0, 3)
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['podcast-bookmarks', showId] })
    void qc.invalidateQueries({ queryKey: ['podcast-bookmarks'] })
  }
  return (
    <section className="mb-6">
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-bold">
        <Bookmark className="size-4 text-brand" /> Bookmarks
      </h2>
      <div className="space-y-0.5">
        {visible.map(b => <BookmarkRow key={b.id} bookmark={b} showThumb={false} onChanged={refresh} />)}
      </div>
      {bookmarks.length > 3 && (
        <button onClick={() => setShowAll(v => !v)} className="mt-1 px-3 text-xs font-medium text-muted-foreground hover:text-foreground">
          {showAll ? 'Show fewer' : `Show all ${bookmarks.length}`}
        </button>
      )}
    </section>
  )
}

/** Auto-download prefs, rendered inside the settings dropdown. */
function AutoDownloadSettings({ showId, subscription }: {
  showId: string
  subscription: { autoDownload: boolean; autoDownloadKeep: number | null }
}) {
  const qc = useQueryClient()
  const [auto, setAuto] = useState(subscription.autoDownload)
  const [keep, setKeep] = useState(subscription.autoDownloadKeep ?? 3)
  useEffect(() => {
    setAuto(subscription.autoDownload)
    setKeep(subscription.autoDownloadKeep ?? 3)
  }, [subscription.autoDownload, subscription.autoDownloadKeep])

  async function toggleAuto(v: boolean) {
    setAuto(v)
    try {
      await updateSubscription(showId, { autoDownload: v })
      await qc.invalidateQueries({ queryKey: ['podcast-shows'] })
      toast.success(v ? 'New episodes will download automatically.' : 'Auto-download turned off.')
    } catch {
      setAuto(!v)
      toast.error('Could not update auto-download.')
    }
  }

  async function commitKeep(raw: number) {
    const n = Math.max(1, Math.min(20, Math.round(raw) || 3))
    setKeep(n)
    try {
      await updateSubscription(showId, { autoDownloadKeep: n })
      await qc.invalidateQueries({ queryKey: ['podcast-shows'] })
    } catch {
      toast.error('Could not update the keep count.')
    }
  }

  return (
    <div className="space-y-2.5 px-2 py-2">
      <label className="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium">
        <span className="flex items-center gap-1.5"><ArrowDownToLine className="size-3.5" /> Auto-download new episodes</span>
        <Switch checked={auto} onCheckedChange={v => void toggleAuto(v)} className="scale-75" />
      </label>
      {auto && (
        <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          Keep latest
          <input
            type="number" min={1} max={20} value={keep}
            onChange={e => setKeep(Number(e.target.value))}
            onBlur={e => void commitKeep(Number(e.target.value))}
            className="w-14 rounded-control border border-border bg-background px-1.5 py-0.5 text-right text-xs outline-none focus:ring-1 focus:ring-brand"
          />
        </label>
      )}
    </div>
  )
}

/** One episode row - click to expand the full description inline. */
function RssEpisodeRow({ episode, show, readyTracks, onPlay, expanded, onToggle, onInvalidate }: {
  episode: Episode
  show: Pick<Show, 'id' | 'name'>
  readyTracks: ReturnType<typeof toTrack>[]
  onPlay: () => void
  expanded: boolean
  onToggle: () => void
  onInvalidate: () => Promise<void>
}) {
  const { track, playing, play, enqueue, playNextInQueue, pause, resume, seek } = usePodcastPlayback()
  const [confirmRemoveDl, setConfirmRemoveDl] = useState(false)
  const isCurrent = track?.episodeId === episode.id
  const ready = episode.status === 'ready'
  const dl = episode.download ?? null
  const progress = episode.watchState
  const pct = progress && episode.durationSec ? Math.min(100, (progress.positionSec / episode.durationSec) * 100) : 0

  function handlePlay(e?: React.MouseEvent) {
    e?.stopPropagation()
    if (!ready) return
    if (isCurrent) { playing ? pause() : resume(); return }
    if (readyTracks.some(t => t.episodeId === episode.id)) onPlay()
    else play(toTrack(episode, show), progress?.positionSec ?? 0)
  }

  async function handleDownload(e?: React.MouseEvent) {
    e?.stopPropagation()
    try {
      await downloadEpisode(episode.id)
      await onInvalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download the episode.')
    }
  }
  async function handleRemoveDownload() {
    try {
      await removeEpisodeDownload(episode.id)
      await onInvalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the download.')
    }
  }

  /** Jump to a soundbite: seek when this episode is already loaded, otherwise start it
   *  at that moment. Either way the tap lands on the highlight. */
  function handleSeekHighlight(startSec: number) {
    if (!ready) return
    if (isCurrent) { seek(startSec); if (!playing) resume(); return }
    play(toTrack(episode, show), startSec)
  }

  return (
    <>
      <EpisodeRowFrame
        onToggle={onToggle}
        expanded={expanded}
        highlight={cn(isCurrent && 'bg-accent/30', expanded && !isCurrent && 'bg-accent/10')}
        leading={
          <button onClick={handlePlay} disabled={!ready}
            title={isCurrent && playing ? 'Pause' : 'Play'}
            className={cn('mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full transition-colors',
              isCurrent
                ? 'bg-brand text-brand-foreground'
                : 'bg-muted text-foreground group-hover:bg-brand group-hover:text-brand-foreground')}>
            {isCurrent && playing
              ? <Pause className="size-4 fill-current" />
              : <Play className="ml-0.5 size-4 fill-current" />}
          </button>
        }
        rightExtras={<>
          {!dl && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={e => void handleDownload(e)} title="Download for offline" aria-label="Download for offline"
              className="size-8 text-muted-foreground/60 hover:text-foreground">
              <ArrowDownToLine className="size-4" />
            </Button>
          )}
          {(dl?.status === 'pending' || dl?.status === 'downloading') && (
            <span title="Downloading…" className="flex size-8 items-center justify-center text-brand">
              <Spinner className="text-current" />
            </span>
          )}
          {dl?.status === 'ready' && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setConfirmRemoveDl(true)} title="Downloaded - remove offline copy" aria-label="Remove offline copy"
              className="size-8 text-brand hover:text-brand">
              <Check className="size-4" />
            </Button>
          )}
          {dl?.status === 'failed' && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={e => void handleDownload(e)} title="Download failed - retry" aria-label="Retry download"
              className="size-8 text-destructive hover:text-destructive">
              <RotateCw className="size-4" />
            </Button>
          )}
        </>}
      >
        <EpisodeRowTitle title={episode.title} expanded={expanded} current={isCurrent} />
        <EpisodeRowMeta>
          {episode.publishedAt && <span>{fmtDate(episode.publishedAt)}</span>}
          {episode.durationSec ? <span>· {fmtDuration(episode.durationSec)}</span> : null}
          {dl?.status === 'ready' && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand">
              <Check className="size-3" /> Downloaded
            </span>
          )}
          {(dl?.status === 'pending' || dl?.status === 'downloading') && (
            <span className="inline-flex items-center gap-0.5 text-brand">
              <Spinner size="sm" className="text-current" /> Downloading
            </span>
          )}
          {dl?.status === 'failed' && (
            <span className="inline-flex items-center gap-0.5 text-destructive">
              <AlertCircle className="size-3" /> Download failed
            </span>
          )}
          {progress?.completed && (
            <span className="inline-flex items-center gap-0.5 text-success"><Check className="size-3" /> Played</span>
          )}
        </EpisodeRowMeta>
        {episode.description && <EpisodeRowDescription text={episode.description} expanded={expanded} />}
        {pct > 0 && !progress?.completed && (
          <div className="mt-2 h-1 w-full max-w-48 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
          </div>
        )}

        {/* Expanded: Podcasting 2.0 episode credits + soundbite highlights, then actions. */}
        {expanded && (
          <div onClick={e => e.stopPropagation()}>
            <PodcastCredits persons={episode.persons} title="In this episode" className="mt-3" />
            <PodcastHighlights soundbites={episode.soundbites} onSeek={handleSeekHighlight} className="mt-3" />
          </div>
        )}

        {expanded && (
          <div className="mt-3 flex flex-wrap items-center gap-2" onClick={e => e.stopPropagation()}>
            {ready && (
              <Button type="button" size="sm" onClick={handlePlay} className="gap-1.5 font-semibold">
                {isCurrent && playing ? <><Pause className="size-3.5 fill-current" /> Pause</> : <><Play className="size-3.5 fill-current" /> Play</>}
              </Button>
            )}
            {ready && (
              <Button type="button" variant="outline" size="sm" onClick={() => playNextInQueue(toTrack(episode, show))}
                className="gap-1.5 text-muted-foreground hover:text-foreground">
                <ListStart className="size-3.5" /> Play next
              </Button>
            )}
            {ready && (
              <Button type="button" variant="outline" size="sm" onClick={() => enqueue(toTrack(episode, show))}
                className="gap-1.5 text-muted-foreground hover:text-foreground">
                <ListPlus className="size-3.5" /> Add to queue
              </Button>
            )}
            {!dl && (
              <Button type="button" variant="outline" size="sm" onClick={e => void handleDownload(e)}
                className="gap-1.5 text-muted-foreground hover:text-foreground">
                <ArrowDownToLine className="size-3.5" /> Download
              </Button>
            )}
            {dl?.status === 'failed' && (
              <Button type="button" variant="outline" size="sm" onClick={e => void handleDownload(e)}
                className="gap-1.5 text-destructive hover:text-destructive">
                <RotateCw className="size-3.5" /> Retry download
              </Button>
            )}
            {dl?.status === 'ready' && (
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirmRemoveDl(true)}
                className="gap-1.5 text-muted-foreground hover:text-foreground">
                <Trash2 className="size-3.5" /> Remove download
              </Button>
            )}
            {episode.link && (
              <a href={episode.link} target="_blank" rel="noreferrer"
                className="flex items-center gap-1.5 rounded-full px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline">
                Episode page <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        )}
      </EpisodeRowFrame>

      <ConfirmDialog
        open={confirmRemoveDl}
        onOpenChange={setConfirmRemoveDl}
        title="Remove download"
        description={`Remove the offline copy of "${episode.title}"? You can still stream it.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => void handleRemoveDownload()}
      />
    </>
  )
}
