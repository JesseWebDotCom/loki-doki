import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ExternalLink, GripVertical, Info, Music2, Play } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { getLyrics, getSongInfo, getArtistInfo, getSongSmartLinks, getStation, getStationTuning, prefetchMedia, type LyricLine } from '@/lib/music/catalogApi'
import { proxyImg } from '@/lib/img'
import { isYouTubeRef } from '@/lib/music/trackRef'
import { useRadio } from '@/context/RadioContext'
import { SongArt } from '@/components/music/SongArt'
import { useLyricsTranslation, LyricsLanguageMenu } from '@/components/music/LyricsTranslation'
import { useTitleMask } from '@/lib/music/policy'
import type { QueuedTrack } from '@/lib/music/radioEngine'

// Shared building blocks for the Now Playing surfaces (the app-wide player overlay and any
// deep-link page). Extracted from the old NowPlayingPage so lyrics/about/links never diverge.

export function SectionLabel({ icon: Icon, color, children }: { icon: typeof Music2; color: string; children: React.ReactNode }) {
  return (
    <h2 className="mb-2.5 flex items-center gap-2 text-sm font-bold">
      <span className="flex size-6 items-center justify-center rounded-control" style={{ background: `${color}26` }}>
        <Icon className="size-3.5" style={{ color }} />
      </span>
      {children}
    </h2>
  )
}

// Default seconds a line lights up BEFORE its vocal onset. Forced alignment gives the exact moment
// a word starts, but reading/singing along wants the line to arrive early so you're ready on the
// beat — highlighting exactly on the onset reads as "a beat late". User-tunable in Music settings
// (Music → Settings → Lyrics); this is the fallback default (0 = highlight on the word).
export const DEFAULT_LYRIC_LEAD_SEC = 0

// Count-in ("get ready — this line is coming up NOW"). During an instrumental gap before a line we
// fill a bar over the last COUNTIN_SEC so the singer sees the cue approach; only shown when the gap
// is long enough that a heads-up actually helps (rapid back-to-back lines don't need one).
const COUNTIN_SEC = 3.2
const COUNTIN_MIN_GAP = 2.0

// The line whose (lead-adjusted) timestamp has most recently passed. Once advanced the index never
// retreats on its own — only a real seek (a >0.75s backward jump in position) moves it backward.
// Without that guard, a `position` reading that jitters by a few ms right at a line boundary (frame
// timing, GC pauses) flips the index back and forth, which reads as "an old row lighting up".
//
// `offsetSec` shifts LRCLIB's timestamps to this track's actual audio - LRCLIB lines are timed to
// whatever recording it matched, which may be a different edit than what's playing. Forced-aligned
// lines pass offsetSec 0. A line is "reached" once `line.sec - LEAD <= position - offsetSec`.
export function useActiveLyricIndex(synced: LyricLine[] | null, position: number, offsetSec = 0, leadSec = DEFAULT_LYRIC_LEAD_SEC): number {
  const lastIdxRef = useRef(-1)
  const lastPosRef = useRef(0)
  const adjPosition = position - offsetSec + leadSec
  return useMemo(() => {
    if (!synced || !synced.length) { lastIdxRef.current = -1; lastPosRef.current = adjPosition; return -1 }
    let idx = -1
    for (let i = 0; i < synced.length; i++) { if (synced[i]!.sec <= adjPosition) idx = i; else break }
    const jumpedBack = adjPosition < lastPosRef.current - 0.75
    lastPosRef.current = adjPosition
    if (jumpedBack || idx > lastIdxRef.current) lastIdxRef.current = idx
    return lastIdxRef.current
  }, [synced, adjPosition])
}

// Fill fraction (0→1) for the count-in cue toward the next line, or null when no cue should show.
// Based on the RAW lyric-time position (no lead) so the bar completes exactly at the vocal onset.
function nextLineCue(synced: LyricLine[] | null, tLyric: number, activeIdx: number): number | null {
  if (!synced?.length) return null
  const upIdx = activeIdx < 0 ? 0 : activeIdx + 1
  const up = synced[upIdx]
  if (!up) return null
  const prevSec = upIdx > 0 ? (synced[upIdx - 1]?.sec ?? 0) : 0
  const gap = up.sec - prevSec
  const remaining = up.sec - tLyric
  if (gap < COUNTIN_MIN_GAP || remaining <= 0 || remaining > COUNTIN_SEC) return null
  return 1 - remaining / COUNTIN_SEC
}

// Thin progress bar that fills as the next lyric approaches and completes on its onset.
function CountInBar({ fill, className }: { fill: number | null; className?: string }) {
  return (
    <div className={cn('h-1 overflow-hidden rounded-full bg-foreground/10 transition-opacity duration-300', fill == null ? 'opacity-0' : 'opacity-100', className)}>
      <div className="h-full rounded-full bg-brand transition-[width] duration-100 ease-linear" style={{ width: `${Math.round((fill ?? 0) * 100)}%` }} />
    </div>
  )
}

// Synced (or plain) lyrics that auto-scroll the active line, driven by a caller-supplied playback
// position (radio.positionSec on Now Playing, StemEngine.getPosition() in Music Studio). Kept
// presentational/prop-driven so it works with any playback source.
//
// `alignedLines`: pre-aligned [{sec, text}] timed to THIS exact recording (Music Studio's forced
// alignment against the vocals stem). When present, these are used verbatim — no LRCLIB fetch, no
// offset guessing — because the timing is already correct for the audio being played.
export function LyricsPanel({ artist, title, position, duration, onSeek, offsetSec = 0, alignedLines }: {
  artist: string; title: string; position: number; duration?: number; onSeek?: (sec: number) => void; offsetSec?: number; alignedLines?: LyricLine[]
}) {
  const haveAligned = !!alignedLines?.length
  const { data, isLoading } = useQuery({
    queryKey: ['music-lyrics', artist, title, duration], queryFn: () => getLyrics(artist, title, duration),
    enabled: !!title && !haveAligned, staleTime: Infinity,
  })
  const synced = haveAligned ? alignedLines! : (data?.synced ?? null)
  const effOffset = haveAligned ? 0 : offsetSec
  const { lyricLeadSec } = useRadio()
  const containerRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLParagraphElement>(null)
  const activeIdx = useActiveLyricIndex(synced, position, effOffset, lyricLeadSec)
  const cue = nextLineCue(synced, position - effOffset, activeIdx)
  // Optional translation/pronunciation, rendered as a secondary line under each lyric line.
  const translation = useLyricsTranslation(artist, title, synced)

  // Scroll ONLY the lyrics box (not the page) to keep the active line centered.
  useEffect(() => {
    const c = containerRef.current, a = activeRef.current
    if (!c || !a) return
    c.scrollTo({ top: a.offsetTop - c.clientHeight / 2 + a.clientHeight / 2, behavior: 'smooth' })
  }, [activeIdx])

  const empty = (msg: string, icon = true) => (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
      {icon && <Music2 className="size-7 opacity-30" />}
      <p className="text-sm">{msg}</p>
    </div>
  )

  if (!haveAligned && isLoading) return empty('Looking for lyrics…')
  if (!haveAligned && data?.restricted) return empty('Lyrics are hidden by your family’s content settings.')
  if (synced?.length) {
    return (
      <div className="relative h-full">
        <div className="absolute right-3 top-2 z-10">
          <LyricsLanguageMenu state={translation} />
        </div>
        <div ref={containerRef} className="h-full space-y-1.5 overflow-y-auto px-5 py-6">
          {synced.map((l, i) => {
            const sec = translation.secondary?.[i] ?? null
            return (
              <div key={i}>
                <p ref={i === activeIdx ? activeRef : undefined}
                  onClick={onSeek ? () => onSeek(l.sec + effOffset) : undefined}
                  className={cn('text-lg font-semibold leading-snug transition-all duration-150',
                    onSeek && 'cursor-pointer hover:text-foreground',
                    i === activeIdx ? 'scale-[1.02] text-foreground' : i < activeIdx ? 'text-muted-foreground/40' : 'text-muted-foreground/70')}>
                  {l.text || '♪'}
                </p>
                {sec && translation.showRoman && sec.r && (
                  <p className={cn('text-sm leading-snug', i === activeIdx ? 'text-foreground/70' : 'text-muted-foreground/50')}>{sec.r}</p>
                )}
                {sec?.t && (
                  <p className={cn('text-sm leading-snug', i === activeIdx ? 'text-foreground/60' : 'text-muted-foreground/40')}>{sec.t}</p>
                )}
              </div>
            )
          })}
        </div>
        {/* Count-in bar pinned at the bottom: fills as the next line's cue approaches. */}
        <div className="pointer-events-none absolute inset-x-5 bottom-3">
          <CountInBar fill={cue} />
        </div>
      </div>
    )
  }
  if (data?.plain) {
    return <div className="h-full overflow-y-auto whitespace-pre-wrap px-5 py-4 text-sm leading-relaxed text-foreground/90">{data.plain}</div>
  }
  if (data?.source === 'instrumental') return empty('Instrumental, no lyrics.')
  return empty('No lyrics found for this track.')
}

// Compact 3-line karaoke ticker (previous / active / next) for tight header real estate -
// e.g. Music Studio's now-playing card. Click to open the full LyricsPanel. Shares the
// music-lyrics query cache with LyricsPanel, so opening the full view is instant.
export function LyricsTicker({ artist, title, position, duration, onOpen, className, offsetSec = 0, alignedLines }: {
  artist: string; title: string; position: number; duration?: number; onOpen: () => void; className?: string; offsetSec?: number; alignedLines?: LyricLine[]
}) {
  const haveAligned = !!alignedLines?.length
  const { data } = useQuery({
    queryKey: ['music-lyrics', artist, title, duration], queryFn: () => getLyrics(artist, title, duration),
    enabled: !!title && !haveAligned, staleTime: Infinity,
  })
  const { lyricLeadSec } = useRadio()
  const effOffset = haveAligned ? 0 : offsetSec
  const synced = haveAligned ? alignedLines! : (data?.synced ?? null)
  const activeIdx = useActiveLyricIndex(synced, position, effOffset, lyricLeadSec)
  const cue = nextLineCue(synced, position - effOffset, activeIdx)
  if (!synced?.length) return null

  // Before the first line's timestamp, activeIdx is -1 (nothing sung yet) - preview the song's
  // opening lines instead of centering on a nonexistent "active" line.
  const rows = activeIdx < 0 ? [synced[0], synced[1], synced[2]] : [synced[activeIdx - 1], synced[activeIdx], synced[activeIdx + 1]]
  const activeRow = activeIdx < 0 ? -1 : 1
  return (
    <button type="button" onClick={onOpen}
      className={cn('flex w-full flex-col justify-center gap-1 rounded-card bg-muted/50 px-4 py-2.5 text-left transition-colors hover:bg-muted', className)}>
      {rows.map((l, i) => (
        <p key={i} className={cn('truncate text-sm leading-snug',
          i === activeRow ? 'font-semibold text-foreground' : 'text-muted-foreground/60')}>
          {l ? (l.text || '♪') : ' '}
        </p>
      ))}
      {/* Count-in: fills toward the next line during an instrumental gap so you know when to come in. */}
      <CountInBar fill={cue} className="mt-1" />
    </button>
  )
}

// One concise paragraph of fun facts about the song (preferred) or the artist, with a link to
// the full source.
export function AboutStrip({ artist, title, color }: { artist: string; title: string; color: string }) {
  const { data: song } = useQuery({ queryKey: ['music-song-info-v2', artist, title], queryFn: () => getSongInfo(artist, title), enabled: !!title, staleTime: Infinity })
  const { data: art } = useQuery({ queryKey: ['music-artist-info-v3', artist], queryFn: () => getArtistInfo(artist), enabled: !!artist, staleTime: Infinity })

  const pick = song?.found && song.extract
    ? { extract: song.extract, url: song.url, label: 'About this song' }
    : art?.found && art.extract
      ? { extract: art.extract, url: art.url, label: `About ${art.title ?? artist}` }
      : null
  if (!pick) return null

  return (
    <Card className="border-l-[3px] bg-card/60 px-4 py-3" style={{ borderLeftColor: color }}>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/70">
        <Info className="size-3.5" style={{ color }} /> {pick.label}
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground line-clamp-3">{pick.extract}</p>
      {pick.url && (
        <a href={pick.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold hover:underline" style={{ color }}>
          <ExternalLink className="size-3" /> Read more on Wikipedia
        </a>
      )}
    </Card>
  )
}

export function SmartLinksRow({ artist, title, color }: { artist: string; title: string; color: string }) {
  const { data } = useQuery({
    queryKey: ['music-smart-links', artist, title],
    queryFn: () => getSongSmartLinks(artist, title),
    enabled: !!artist && !!title,
    staleTime: Infinity,
  })
  const links = data?.links ?? []
  if (!links.length) return null
  return (
    <div className="flex flex-wrap gap-2">
      {links.map(l => (
        <a key={l.platform} href={l.url} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2.5 py-1 text-xs font-medium transition hover:bg-accent"
          style={{ color }}>
          <ExternalLink className="size-3 shrink-0" />
          {l.platform}
        </a>
      ))}
    </div>
  )
}

// ── Up Next (shared by the overlay player and the Now Playing page) ────────────────
// Plexamp queue behaviors: drag a row (by its grip) to reorder what plays after the
// current song, click a row to play it now. Purely a view over radio.queue - the engine
// owns the live array (reorderQueue/jumpTo splice it in place).

function UpNextRow({ id, track, n, absIndex }: { id: string; track: QueuedTrack; n: number; absIndex: number }) {
  const radio = useRadio()
  const mask = useTitleMask()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('group flex items-center gap-3 rounded-control px-2 py-1.5 transition-colors hover:bg-foreground/[0.06]',
        isDragging && 'relative z-10 bg-foreground/[0.08] shadow-lg')}>
      <button type="button" onClick={() => radio.jumpTo(absIndex)}
        className="relative grid w-4 shrink-0 place-items-center text-center text-xs tabular-nums text-muted-foreground/60"
        aria-label={`Play ${track.title} now`} title="Play now">
        <span className="group-hover:opacity-0">{n}</span>
        <Play className="absolute size-3.5 fill-current text-foreground opacity-0 group-hover:opacity-100" />
      </button>
      <SongArt trackRef={track.videoId} title={track.title} artist={track.author} className="size-10" rounded="rounded-control" />
      <button type="button" onClick={() => radio.jumpTo(absIndex)} className="min-w-0 flex-1 text-left" title="Play now">
        <p className="truncate text-sm font-medium">{mask(track.title)}</p>
        {track.author && <p className="truncate text-xs text-muted-foreground">{track.author}</p>}
      </button>
      <button type="button" {...attributes} {...listeners}
        className="grid size-8 shrink-0 cursor-grab touch-none place-items-center rounded-control text-muted-foreground/50 opacity-0 transition hover:text-foreground group-hover:opacity-100 active:cursor-grabbing"
        aria-label={`Reorder ${track.title}`} title="Drag to reorder">
        <GripVertical className="size-4" />
      </button>
    </div>
  )
}

export function UpNextList({ tracks, baseIndex }: {
  /** The queue tail after the current track (radio.queue.slice(radio.index + 1, …)). */
  tracks: QueuedTrack[]
  /** Absolute queue index of tracks[0] (radio.index + 1). */
  baseIndex: number
}) {
  const radio = useRadio()
  // A grip-drag must move a few px before dnd-kit claims the pointer, so plain clicks
  // (play-now) on the same rows never get eaten by the sensor.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const ids = tracks.map((t, i) => `${t.videoId}:${baseIndex + i}`)
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const from = ids.indexOf(String(e.active.id))
    const to = ids.indexOf(String(e.over.id))
    if (from < 0 || to < 0) return
    radio.reorderQueue(baseIndex + from, baseIndex + to)
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {tracks.map((t, i) => (
          <UpNextRow key={ids[i]!} id={ids[i]!} track={t} n={i + 1} absIndex={baseIndex + i} />
        ))}
      </SortableContext>
    </DndContext>
  )
}

// Generic fallback shown for the blink before the station's own lines load (or for legacy
// preset stations with no saved id). The per-station LLM-written set replaces these.
const FALLBACK_TUNING = [
  'Warming up the speakers…',
  'Lining up the perfect first track…',
  'Cueing something good…',
  'Finding the groove…',
]

// Fills the lyrics area while a station spins up: pulsing equalizer + rotating playful
// "tuning in" lines pulled from the station's stored, LLM-written set. Shared by the
// NowPlayingOverlay (the one full player) and any future lyric surface.
export function TuningLyrics({ stationId, color }: { stationId?: string; color: string }) {
  const { data } = useQuery({
    queryKey: ['station-tuning', stationId], queryFn: () => getStationTuning(stationId!),
    enabled: !!stationId, staleTime: Infinity,
  })
  const messages = data?.messages?.length ? data.messages : FALLBACK_TUNING
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI(n => n + 1), 5500)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="flex items-end gap-1.5" aria-hidden>
        {[14, 22, 11, 18, 13].map((h, n) => (
          // design-ok(adhoc-pulse): bespoke station-tint tuning equalizer, not a loading skeleton
          <span key={n} className="w-1.5 rounded-full animate-pulse"
            style={{ background: color, height: h, animationDelay: `${n * 130}ms`, animationDuration: '1100ms' }} />
        ))}
      </div>
      <p key={i} className="max-w-xs text-lg font-semibold text-foreground/90 animate-in fade-in duration-700">
        {messages[i % messages.length]}
      </p>
    </div>
  )
}

// Where this station came from (a movie/show soundtrack pivot). Fast path: sourceRef is
// carried in the DjStation shape; fallback fetches the station row for stations started
// before sourceRef existed.
export function useSourceBackLink(): { url: string; label: string } | null {
  const radio = useRadio()
  const stationId = radio.station?.stationId
  const { data: stationDetail } = useQuery({
    queryKey: ['station', stationId],
    queryFn: () => getStation(stationId!),
    enabled: !!stationId && !radio.station?.sourceRef,
    staleTime: Infinity,
  })
  const sourceRef = radio.station?.sourceRef ?? stationDetail?.station.sourceRef ?? ''
  const movieM = sourceRef.match(/^source:movie:(.+)$/)
  if (movieM) return { url: `/movies/${movieM[1]}`, label: decodeURIComponent(movieM[1]) }
  const showM = sourceRef.match(/^source:show:(\d+):(.+)$/)
  if (showM) return { url: `/shows/${showM[1]}`, label: decodeURIComponent(showM[2]) }
  return null
}

// Warm the NEXT track's content (art, lyrics, Wikipedia, smart links) into the query cache
// while the current song still plays (everything is staleTime:Infinity, so the flip renders
// instantly), plus the current song's 480p video so "Switch to video" is instant. Runs
// whenever radio is active; safe to keep warm even while the overlay is closed.
export function useNowPlayingPrefetch(): void {
  const radio = useRadio()
  const queryClient = useQueryClient()
  const next = radio.nextTrack
  useEffect(() => {
    if (!next?.title) return
    const artist = next.author ?? ''
    const title = next.title
    const warm = (key: unknown[], fn: () => Promise<unknown>) =>
      void queryClient.prefetchQuery({ queryKey: key, queryFn: fn, staleTime: Infinity })
    warm(['music-lyrics', artist, title], () => getLyrics(artist, title))
    if (title) warm(['music-song-info-v2', artist, title], () => getSongInfo(artist, title))
    if (artist) warm(['music-artist-info-v3', artist], () => getArtistInfo(artist))
    if (artist && title) warm(['music-smart-links', artist, title], () => getSongSmartLinks(artist, title))
    if (next.thumbnail) { const img = new Image(); img.src = proxyImg(next.thumbnail) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next?.videoId, next?.title, next?.author, next?.thumbnail, queryClient])

  const cur = radio.currentTrack ?? radio.queue[radio.index] ?? null
  const watchableStation = radio.station?.stationId
  useEffect(() => {
    if (cur?.videoId && watchableStation && isYouTubeRef(cur.videoId)) void prefetchMedia(cur.videoId, 'video', 480)
  }, [cur?.videoId, watchableStation])
}
