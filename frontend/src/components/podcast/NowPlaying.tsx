import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Play, Pause, RotateCcw, RotateCw, Moon, GripVertical, X, Download,
  ChevronsLeft, ChevronsRight, BookmarkPlus, MoreHorizontal, Settings2, Trash2, TimerOff,
  Scissors, ExternalLink, Megaphone, Volume2, VolumeX,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { usePodcastPlayback, type PodcastTrack } from '@/context/PodcastPlaybackContext'
import { usePodcastDspPrefs, useTimeSaved, fmtTimeSaved } from '@/hooks/usePodcastPlayerPrefs'
import { ShowCover } from '@/components/podcast/ShowCover'
import { ShowPlaybackSettings } from '@/components/podcast/ShowPlaybackSettings'
import { TranscriptPanel } from '@/components/podcast/TranscriptPanel'
import { coverUrl, getEpisodeDetail, type EpisodeDetail } from '@/lib/podcast/api'
import { createBookmark } from '@/lib/podcast/playerApi'
import { createSnip, reportAdCorrection } from '@/lib/podcast/aiApi'
import { accentOf, DEFAULT_PALETTE, useArtPalette } from '@/lib/artPalette'
import { accentVars } from '@/components/shared/ArtAccentScope'
import { UltraBlur } from '@/components/shared/UltraBlur'
import { SeekBar } from '@/components/shared/SeekBar'
import { fmtTime, fmtDate } from '@/lib/podcast/format'
import { Link as RouterLink } from 'react-router-dom'

type Tab = 'chapters' | 'transcript' | 'details'
const RATES = [0.75, 1, 1.25, 1.5, 2]
const SLEEP_MINUTES = [15, 30, 60]

export function NowPlaying() {
  const {
    track, playing, positionSec, duration, rate, autoplay, queue, chapters, adSegments, adStatus, adPrepLabel, retryAdDetection, sleep, volume, setVolume,
    pause, resume, seek, setRate, setAutoplay, setSleep,
    nextChapter, prevChapter, playFromQueue, removeFromQueue, reorderQueue, clearQueue,
  } = usePodcastPlayback()
  const { voiceBoost, trimSilence, setVoiceBoost, setTrimSilence } = usePodcastDspPrefs()
  const timeSaved = useTimeSaved()
  const [tab, setTab] = useState<Tab>('chapters')
  const [detail, setDetail] = useState<EpisodeDetail | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [snipping, setSnipping] = useState(false)
  const [reportingAd, setReportingAd] = useState(false)
  // Mute remembers the level to restore. The player's volume lives in the context
  // (applied through the audio graph, and clamped by the family volume cap).
  const [preMuteVolume, setPreMuteVolume] = useState(1)
  const muted = volume === 0
  const toggleMute = () => {
    if (muted) setVolume(preMuteVolume > 0 ? preMuteVolume : 1)
    else { setPreMuteVolume(volume); setVolume(0) }
  }

  // Immersive backdrop: the show cover through UltraBlur, with the whole panel's
  // chrome (play button, tabs, links) retinted to the cover palette. Always-dark,
  // matching the Music player posture, regardless of the app theme.
  const art = track?.showId ? coverUrl(track.showId) : null
  const palette = useArtPalette(art)
  const accent = accentOf(palette)

  useEffect(() => {
    setDetail(null)
    if (!track) return
    let alive = true
    getEpisodeDetail(track.episodeId).then(d => { if (alive) setDetail(d) }).catch(() => {})
    return () => { alive = false }
  }, [track?.episodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  if (!track) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
        <div className="flex size-16 items-center justify-center rounded-card bg-muted/50"><Play className="size-7 opacity-40" /></div>
        <p className="text-sm">Pick an episode to start listening.</p>
      </div>
    )
  }

  const total = track.durationSec || duration || 0
  const chIndex = (() => {
    for (let i = chapters.length - 1; i >= 0; i--) if (positionSec >= chapters[i]!.startSec) return i
    return -1
  })()
  const currentChapter = chIndex >= 0 ? chapters[chIndex] : null

  const cycleRate = () => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1)

  async function handleBookmark() {
    if (!track) return
    try {
      await createBookmark(track.episodeId, Math.floor(positionSec))
      toast.success(`Bookmarked at ${fmtTime(positionSec)}.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the bookmark.')
    }
  }

  // "Clip that": the transcript around this second, LLM-titled and filed as a snip.
  async function handleSnip() {
    if (!track || snipping) return
    setSnipping(true)
    try {
      const snip = await createSnip(track.episodeId, positionSec)
      toast.success(`Snipped "${snip.title}".`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the snip.')
    } finally {
      setSnipping(false)
    }
  }

  // "This is an ad the scan missed": record the spot and force a rescan.
  async function handleReportAd() {
    if (!track || reportingAd) return
    setReportingAd(true)
    try {
      await reportAdCorrection(track.episodeId, { kind: 'missed', positionSec: Math.floor(positionSec) })
      toast.success('Thanks. This episode will be rescanned for ads.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send the report.')
    } finally {
      setReportingAd(false)
    }
  }

  function onQueueDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = queue.map(t => t.episodeId)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    reorderQueue(arrayMove(ids, from, to))
  }

  const sleepLabel = sleep.mode === 'timer' ? `${sleep.minutes}m` : sleep.mode === 'episode' ? 'Ep' : sleep.mode === 'chapter' ? 'Ch' : null

  return (
    <div data-theme="dark" className="relative flex h-full flex-col overflow-hidden rounded-[inherit] bg-black text-foreground"
      style={palette !== DEFAULT_PALETTE ? accentVars(palette) : undefined}>
      <UltraBlur artUrl={art} palette={palette} />
      <div className="relative min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto w-full max-w-xl">
      {/* Cover + meta */}
      <ShowCover showId={track.showId ?? ''} title={track.showName} size={248} rounded="rounded-card" className="mx-auto shadow-2xl" />
      <div className="mt-4">
        {track.showId
          ? <Link to={`/podcasts/show/${track.showId}`} className="text-xs font-semibold text-brand hover:underline">{track.showName}</Link>
          : <span className="text-xs font-semibold text-brand">{track.showName}</span>}
        <h2 className="mt-1 text-lg font-bold leading-snug">{track.title}</h2>
        {currentChapter && (
          <p className="mt-1 truncate text-xs font-medium text-muted-foreground">
            {currentChapter.title}
          </p>
        )}
        {detail?.generatedAt && <p className="mt-1 text-xs text-muted-foreground">{fmtDate(detail.generatedAt)} · {fmtTime(total)}</p>}
      </div>

      {/* Scrubber (with chapter tick marks) */}
      <div className="mt-4">
        <SeekBar pos={positionSec} total={total || 100} onSeek={seek} accent={accent}
          ticks={chapters.length > 1 ? chapters.map(c => c.startSec) : undefined}
          ranges={adSegments.length ? adSegments : undefined} />
        <div className="mt-1 flex justify-between text-xs tabular-nums text-muted-foreground">
          <span>{fmtTime(positionSec)}</span>
          <span>-{fmtTime(Math.max(0, total - positionSec))}</span>
        </div>
        {adStatus === 'preparing' && (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner size="sm" />
            {adPrepLabel || 'Finding ads'}. Playing with ads until it is ready.
          </p>
        )}
        {adStatus === 'unavailable' && (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate" title={adPrepLabel ?? undefined}>
              {adPrepLabel || 'Ad detection is unavailable for this episode.'}
            </span>
            <button onClick={retryAdDetection} className="shrink-0 font-medium text-brand hover:underline">Try again</button>
          </p>
        )}
        {adStatus === 'ready' && (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {/* design-ok(raw-palette-semantic): semantic "ad range" amber swatch, matches the seek-bar marks */}
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber-400/70" />
            <span className="min-w-0 flex-1">
              {adSegments.length > 0
                ? `${adSegments.length} ad ${adSegments.length === 1 ? 'segment' : 'segments'} marked (amber) and skipped automatically.`
                : 'No ads detected in this episode.'}
            </span>
            <button onClick={retryAdDetection} className="shrink-0 font-medium text-brand hover:underline">Rescan</button>
          </p>
        )}
      </div>

      {/* Transport */}
      <div className="mt-3 flex items-center justify-between">
        <button onClick={cycleRate} className="w-10 text-sm font-semibold text-muted-foreground hover:text-foreground">{rate}x</button>
        <button onClick={() => seek(Math.max(0, positionSec - 15))} className="text-muted-foreground hover:text-foreground" aria-label="Back 15 seconds"><RotateCcw className="size-6" /></button>
        <Button type="button" size="icon" onClick={playing ? pause : resume} className="size-14" aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause className="size-6 fill-current" /> : <Play className="size-6 fill-current ml-0.5" />}
        </Button>
        <button onClick={() => seek(positionSec + 15)} className="text-muted-foreground hover:text-foreground" aria-label="Forward 15 seconds"><RotateCw className="size-6" /></button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={cn('flex w-10 flex-col items-center text-muted-foreground hover:text-foreground', sleep.mode !== 'off' && 'text-brand')} title="Sleep timer" aria-label="Sleep timer">
              <Moon className="size-5" />
              {sleepLabel && <span className="text-[9px] font-semibold leading-none">{sleepLabel}</span>}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Sleep timer</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setSleep('off')}>
              <TimerOff className="size-4" /> Off {sleep.mode === 'off' && <span className="ml-auto text-xs text-muted-foreground">Current</span>}
            </DropdownMenuItem>
            {SLEEP_MINUTES.map(m => (
              <DropdownMenuItem key={m} onSelect={() => setSleep('timer', m)}>
                <Moon className="size-4" /> {m} minutes {sleep.mode === 'timer' && sleep.minutes === m && <span className="ml-auto text-xs text-muted-foreground">Current</span>}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setSleep('episode')}>
              End of episode {sleep.mode === 'episode' && <span className="ml-auto text-xs text-muted-foreground">Current</span>}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={chapters.length === 0} onSelect={() => setSleep('chapter')}>
              End of chapter {sleep.mode === 'chapter' && <span className="ml-auto text-xs text-muted-foreground">Current</span>}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Volume */}
      <div className="mt-3 flex items-center gap-3">
        <button type="button" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}
          className="shrink-0 text-muted-foreground hover:text-foreground">
          {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
        </button>
        <input type="range" min={0} max={1} step={0.01}
          value={volume}
          onChange={e => setVolume(Number(e.target.value))}
          aria-label="Volume"
          className="h-1 flex-1 cursor-pointer"
          style={{ accentColor: accent }}
        />
      </div>

      {/* Secondary controls: chapter skips, bookmark, per-show settings, DSP overflow */}
      <div className="mt-2 flex items-center justify-center gap-1">
        {chapters.length > 1 && (
          <Button type="button" variant="ghost" size="icon-sm" onClick={prevChapter} title="Previous chapter" aria-label="Previous chapter"
            className="size-9 text-muted-foreground hover:text-foreground">
            <ChevronsLeft className="size-5" />
          </Button>
        )}
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => void handleBookmark()} title="Bookmark this moment" aria-label="Bookmark this moment"
          className="size-9 text-muted-foreground hover:text-foreground">
          <BookmarkPlus className="size-5" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => void handleSnip()} disabled={snipping}
          title="Clip that (saves the transcript around this moment)" aria-label="Clip that"
          className="size-9 text-muted-foreground hover:text-foreground">
          <Scissors className="size-5" />
        </Button>
        {chapters.length > 1 && (
          <Button type="button" variant="ghost" size="icon-sm" onClick={nextChapter} title="Next chapter" aria-label="Next chapter"
            className="size-9 text-muted-foreground hover:text-foreground">
            <ChevronsRight className="size-5" />
          </Button>
        )}
        {track.showId && (
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => setSettingsOpen(true)} title="Show playback settings" aria-label="Show playback settings"
            className="size-9 text-muted-foreground hover:text-foreground">
            <Settings2 className="size-5" />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" title="More options" aria-label="More options"
              className="size-9 text-muted-foreground hover:text-foreground">
              <MoreHorizontal className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel>Audio</DropdownMenuLabel>
            <DropdownMenuCheckboxItem checked={voiceBoost} onCheckedChange={setVoiceBoost}>
              Voice boost
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={trimSilence} onCheckedChange={setTrimSilence}>
              Trim silence
            </DropdownMenuCheckboxItem>
            {timeSaved > 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">Time saved so far: {fmtTimeSaved(timeSaved)}</p>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={reportingAd} onSelect={() => void handleReportAd()}>
              <Megaphone className="size-4" /> Report an ad at this spot
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Tabs */}
      <div className="mt-5 flex gap-5 border-b border-border/40">
        {([['chapters', 'Chapters'], ['transcript', 'Transcript'], ['details', 'Details']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={cn('-mb-px border-b-2 pb-2 text-sm font-semibold transition-colors',
              tab === id ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
          </button>
        ))}
      </div>

      <div className="py-3">
        {tab === 'chapters' && (
          chapters.length > 0 ? (
            <div className="space-y-0.5">
              {chapters.map((ch, i) => {
                const active = i === chIndex
                return (
                  <button key={i} onClick={() => seek(ch.startSec)}
                    className={cn('flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted',
                      active ? 'text-brand font-semibold' : 'text-muted-foreground')}>
                    <span className="tabular-nums text-xs">{fmtTime(ch.startSec)}</span>
                    <span className="truncate">{ch.title}</span>
                  </button>
                )
              })}
            </div>
          ) : <p className="px-2 py-6 text-center text-sm text-muted-foreground/60">No chapters.</p>
        )}

        {/* Generated episodes carry their own script (speaker turns, no timings); everything
            else gets the canonical timestamped transcript that follows playback. */}
        {tab === 'transcript' && (
          detail == null ? <p className="px-2 py-6 text-center text-sm text-muted-foreground/60">Loading…</p>
          : detail.transcript.length === 0 ? (
            <>
              <TranscriptPanel episodeId={track.episodeId} positionSec={positionSec} onSeek={seek}
                adSegments={adSegments} compact className="max-h-[46vh]" />
              <RouterLink to={`/podcasts/episode/${track.episodeId}`}
                className="mt-3 flex items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                Open the full episode page <ExternalLink className="size-3" />
              </RouterLink>
            </>
          ) : (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{detail.transcript.length} turns</span>
                <button
                  onClick={() => {
                    const header = [
                      'PODCAST TRANSCRIPT',
                      `Show: ${track.showName}`,
                      `Episode: ${track.title}`,
                      detail.generatedAt ? `Date: ${fmtDate(detail.generatedAt)}` : '',
                    ].filter(Boolean).join('\n')
                    const body = detail.transcript.map(t => `${t.speaker.toUpperCase()}\n${t.text}`).join('\n\n')
                    const text = `${header}\n\n${'─'.repeat(40)}\n\n${body}`
                    const blob = new Blob([text], { type: 'text/plain' })
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = `${track.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-transcript.txt`
                    a.click()
                    URL.revokeObjectURL(url)
                  }}
                  className="flex items-center gap-1.5 rounded-control px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  title="Download transcript"
                >
                  <Download className="size-3.5" />
                  Download
                </button>
              </div>
              <div className="space-y-3">
                {detail.transcript.map((t, i) => (
                  <div key={i}>
                    <p className="text-xs font-semibold text-brand">{t.speaker}</p>
                    <p className="text-sm text-muted-foreground leading-relaxed">{t.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )
        )}

        {tab === 'details' && (
          <dl className="divide-y divide-border/40 text-sm">
            {track.description && <p className="pb-3 text-muted-foreground leading-relaxed">{track.description}</p>}
            {[
              ['Show', track.showName],
              ['Published', detail?.generatedAt ? fmtDate(detail.generatedAt) : '-'],
              ['Duration', total ? fmtTime(total) : '-'],
              ['Chapters', String(chapters.length)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between py-2"><dt className="text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd></div>
            ))}
          </dl>
        )}
      </div>

      {/* Up Next: the server-persisted queue - drag to reorder, tap to jump */}
      <div className="mt-2 border-t border-border/40 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-bold">Up Next{queue.length > 0 ? ` (${queue.length})` : ''}</h3>
          <div className="flex items-center gap-3">
            {queue.length > 0 && (
              <button onClick={clearQueue} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" title="Clear queue">
                <Trash2 className="size-3.5" /> Clear
              </button>
            )}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Autoplay
              <button
                role="switch" aria-checked={autoplay} onClick={() => setAutoplay(!autoplay)}
                className={cn('relative h-5 w-9 rounded-full transition-colors', autoplay ? 'bg-success' : 'bg-muted')}>
                <span className={cn('absolute top-0.5 size-4 rounded-full bg-white transition-transform', autoplay ? 'translate-x-4' : 'translate-x-0.5')} />
              </button>
            </label>
          </div>
        </div>
        {queue.length === 0 ? (
          <p className="py-3 text-xs text-muted-foreground/60">Nothing queued. Use "Play next" or "Add to queue" on any episode.</p>
        ) : (
          <DndContext sensors={sensors} onDragEnd={onQueueDragEnd}>
            <SortableContext items={queue.map(t => t.episodeId)} strategy={verticalListSortingStrategy}>
              <div className="space-y-1">
                {queue.map(t => (
                  <QueueRow key={t.episodeId} track={t}
                    onPlay={() => playFromQueue(t.episodeId)}
                    onRemove={() => removeFromQueue(t.episodeId)} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
      </div>
      </div>

      {track.showId && (
        <ShowPlaybackSettings showId={track.showId} showName={track.showName} open={settingsOpen} onOpenChange={setSettingsOpen} />
      )}
    </div>
  )
}

function QueueRow({ track, onPlay, onRemove }: { track: PodcastTrack; onPlay: () => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: track.episodeId })
  return (
    <div ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('group flex items-center gap-2 rounded-control px-1.5 py-1.5 hover:bg-muted', isDragging && 'z-10 bg-muted shadow-lg')}>
      <button {...attributes} {...listeners} className="cursor-grab touch-none text-muted-foreground/40 hover:text-muted-foreground" aria-label="Drag to reorder">
        <GripVertical className="size-3.5 shrink-0" />
      </button>
      <button onClick={onPlay} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <ShowCover showId={track.showId ?? ''} title={track.showName} size={36} rounded="rounded-control" />
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">{track.title}</p>
          <p className="truncate text-[11px] text-muted-foreground">{track.showName}</p>
        </div>
      </button>
      <button onClick={onRemove} className="shrink-0 text-muted-foreground/50 opacity-0 hover:text-foreground group-hover:opacity-100" aria-label="Remove from queue"><X className="size-3.5" /></button>
    </div>
  )
}
