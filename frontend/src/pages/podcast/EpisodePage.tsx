import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, FileText, ListTree, MessagesSquare, Pause, Play, Scissors } from 'lucide-react'
import { cn } from '@/lib/cn'
import { PageContainer } from '@/components/shared/PageContainer'
import { AppTabBar } from '@/components/shared/AppTabBar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ShowCover } from '@/components/podcast/ShowCover'
import { TranscriptPanel } from '@/components/podcast/TranscriptPanel'
import { EpisodeSummaryCard } from '@/components/podcast/EpisodeSummaryCard'
import { AskEpisodePanel } from '@/components/podcast/AskEpisodePanel'
import { SnipRow } from '@/components/podcast/SnipRow'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { getEpisodeDetail, getShows, toTrack } from '@/lib/podcast/api'
import { getChapters } from '@/lib/podcast/playerApi'
import { getEpisodeTranscript, getSnips } from '@/lib/podcast/aiApi'
import { fmtDate, fmtDuration, fmtTime } from '@/lib/podcast/format'

type Tab = 'transcript' | 'ask' | 'chapters' | 'snips'

/**
 * The AI-native episode page: summary card, transcript that follows playback, an
 * ask-the-episode thread, chapters, and this episode's snips. Deep-linkable at a
 * timestamp via `?t=<seconds>` (what snips and search results link to).
 */
export function EpisodePage() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const [tab, setTab] = useState<Tab>('transcript')
  const { track, playing, positionSec, play, pause, resume, seek } = usePodcastPlayback()

  const { data: episode, isLoading } = useQuery({
    queryKey: ['podcast-episode', id],
    queryFn: () => getEpisodeDetail(id),
    enabled: !!id,
  })
  const { data: shows = [] } = useQuery({ queryKey: ['podcast-shows'], queryFn: getShows })
  const show = useMemo(() => shows.find(s => s.id === episode?.showId) ?? null, [shows, episode?.showId])

  const { data: chapters = [] } = useQuery({
    queryKey: ['podcast-chapters', id],
    queryFn: () => getChapters(id),
    enabled: !!id,
  })
  const { data: transcript } = useQuery({
    queryKey: ['podcast-transcript', id],
    queryFn: () => getEpisodeTranscript(id),
    enabled: !!id,
  })
  const { data: snips = [] } = useQuery({
    queryKey: ['podcast-snips', id],
    queryFn: () => getSnips(id),
    enabled: !!id,
  })

  const isCurrent = track?.episodeId === id
  // The panel follows real playback for the playing episode; otherwise it rests at the
  // deep-linked moment (or the start) so lines are still tappable.
  const deepLinkSec = Number(params.get('t')) || 0
  const [restingSec, setRestingSec] = useState(deepLinkSec)
  const panelPosition = isCurrent ? positionSec : restingSec

  // Deep link: start the episode at ?t= once, when it is not already the current track.
  const [linked, setLinked] = useState(false)
  useEffect(() => {
    if (linked || !deepLinkSec || !episode || !show) return
    setLinked(true)
    if (track?.episodeId === id) seek(deepLinkSec)
    else setRestingSec(deepLinkSec)
  }, [deepLinkSec, episode, show, linked, track?.episodeId, id, seek])

  function handlePlay(startAt?: number) {
    if (!episode || !show) return
    if (isCurrent) {
      if (startAt != null) seek(startAt)
      else playing ? pause() : resume()
      return
    }
    play(toTrack(episode, show), startAt ?? episode.watchState?.positionSec ?? 0)
  }

  /** Seek from a transcript line / chapter / snip: plays this episode if it is not
   *  already playing, so a tap always lands you at the moment you asked for. */
  function seekTo(sec: number) {
    if (isCurrent) seek(sec)
    else { setRestingSec(sec); handlePlay(sec) }
  }

  if (isLoading) return <PageContainer width="narrow" className="py-10"><div className="flex justify-center"><Spinner /></div></PageContainer>
  if (!episode) {
    return (
      <PageContainer width="narrow" className="py-10">
        <p className="text-center text-sm text-muted-foreground">This episode is not available.</p>
      </PageContainer>
    )
  }

  const total = episode.durationSec ?? 0
  const transcriptReady = transcript?.status === 'ready'

  const tabs = [
    { id: 'transcript' as const, label: 'Transcript', icon: FileText },
    { id: 'ask' as const, label: 'Ask this episode', icon: MessagesSquare },
    { id: 'chapters' as const, label: 'Chapters', icon: ListTree },
    { id: 'snips' as const, label: 'Snips', icon: Scissors },
  ]

  return (
    <PageContainer width="narrow" className="py-6 pb-24">
      <Link to={show ? `/podcasts/show/${show.id}` : '/podcasts/library'}
        className="mb-5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 rotate-180" /> {show?.name ?? 'Library'}
      </Link>

      {/* Episode identity + transport */}
      <div className="flex gap-4">
        {show && <ShowCover showId={show.id} title={show.name} size={96} rounded="rounded-card" className="shrink-0" />}
        <div className="min-w-0 flex-1">
          {show && (
            <Link to={`/podcasts/show/${show.id}`} className="text-xs font-semibold text-brand hover:underline">{show.name}</Link>
          )}
          {/* Detail heroes use the display type, not a raw h1 (PageHeader owns h1). */}
          <div className="mt-0.5 text-xl font-bold leading-snug">{episode.title}</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {[fmtDate(episode.publishedAt ?? episode.generatedAt), total ? fmtDuration(total) : ''].filter(Boolean).join(' · ')}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => handlePlay()} disabled={episode.status !== 'ready'}
              className="gap-1.5 font-semibold">
              {isCurrent && playing
                ? <><Pause className="size-3.5 fill-current" /> Pause</>
                : <><Play className="size-3.5 fill-current" /> {isCurrent || episode.watchState?.positionSec ? 'Resume' : 'Play'}</>}
            </Button>
            {isCurrent && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {fmtTime(positionSec)}{total ? ` / ${fmtTime(total)}` : ''}
              </span>
            )}
          </div>
        </div>
      </div>

      {episode.description && (
        <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{episode.description}</p>
      )}

      <EpisodeSummaryCard episodeId={id} className="mt-5" />

      <AppTabBar tabs={tabs} value={tab} onChange={setTab} className="mt-6" />

      <div className="mt-4">
        {tab === 'transcript' && (
          <TranscriptPanel episodeId={id} positionSec={panelPosition} onSeek={seekTo}
            className="max-h-[60vh]" />
        )}

        {tab === 'ask' && (
          <AskEpisodePanel episodeId={id} transcriptReady={!!transcriptReady} onSeek={seekTo} className="max-h-[60vh]" />
        )}

        {tab === 'chapters' && (
          chapters.length > 0 ? (
            <div className="space-y-0.5">
              {chapters.map((ch, i) => {
                const next = chapters[i + 1]
                const active = panelPosition >= ch.startSec && (!next || panelPosition < next.startSec)
                return (
                  <button key={i} onClick={() => seekTo(ch.startSec)}
                    className={cn('flex w-full items-center gap-3 rounded-control px-2 py-2 text-left text-sm transition-colors hover:bg-muted',
                      active ? 'font-semibold text-brand' : 'text-muted-foreground')}>
                    <span className="tabular-nums text-xs">{fmtTime(ch.startSec)}</span>
                    <span className="truncate">{ch.title}</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground/60">
              No chapters. Generate the summary above and chapters come with it when this episode has a transcript.
            </p>
          )
        )}

        {tab === 'snips' && (
          snips.length > 0 ? (
            <div className="space-y-0.5">
              {snips.map(s => <SnipRow key={s.id} snip={s} showEpisode={false} />)}
            </div>
          ) : (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground/60">
              No snips from this episode yet. Hit "Clip that" in the transcript or the player to capture a moment.
            </p>
          )
        )}
      </div>
    </PageContainer>
  )
}
