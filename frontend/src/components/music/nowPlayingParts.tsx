import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Info, Music2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { getLyrics, getSongInfo, getArtistInfo, getSongSmartLinks, type LyricLine } from '@/lib/music/catalogApi'

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

// The line whose timestamp has most recently passed. No look-ahead fudge (a line should light up
// when it's actually reached, not before), and once advanced the index never retreats on its own -
// only a real seek (a >0.75s backward jump in position) is allowed to move it backward. Without
// that guard, a `position` reading that jitters by a few ms right at a line boundary (frame timing,
// GC pauses) flips the index back and forth, which reads as "an old row lighting up".
function useActiveLyricIndex(synced: LyricLine[] | null, position: number): number {
  const lastIdxRef = useRef(-1)
  const lastPosRef = useRef(0)
  return useMemo(() => {
    if (!synced || !synced.length) { lastIdxRef.current = -1; lastPosRef.current = position; return -1 }
    let idx = -1
    for (let i = 0; i < synced.length; i++) { if (synced[i]!.sec <= position) idx = i; else break }
    const jumpedBack = position < lastPosRef.current - 0.75
    lastPosRef.current = position
    if (jumpedBack || idx > lastIdxRef.current) lastIdxRef.current = idx
    return lastIdxRef.current
  }, [synced, position])
}

// Synced (or plain) lyrics that auto-scroll the active line, driven by a caller-supplied playback
// position (radio.positionSec on Now Playing, StemEngine.getPosition() in Music Studio). Kept
// presentational/prop-driven so it works with any playback source.
export function LyricsPanel({ artist, title, position, duration, onSeek }: {
  artist: string; title: string; position: number; duration?: number; onSeek?: (sec: number) => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['music-lyrics', artist, title, duration], queryFn: () => getLyrics(artist, title, duration),
    enabled: !!title, staleTime: Infinity,
  })
  const synced = data?.synced ?? null
  const containerRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLParagraphElement>(null)
  const activeIdx = useActiveLyricIndex(synced, position)

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

  if (isLoading) return empty('Looking for lyrics…')
  if (data?.restricted) return empty('Lyrics are hidden by your family’s content settings.')
  if (synced?.length) {
    return (
      <div ref={containerRef} className="h-full space-y-1.5 overflow-y-auto px-5 py-6">
        {synced.map((l, i) => (
          <p key={i} ref={i === activeIdx ? activeRef : undefined}
            onClick={onSeek ? () => onSeek(l.sec) : undefined}
            className={cn('text-lg font-semibold leading-snug transition-all duration-150',
              onSeek && 'cursor-pointer hover:text-foreground',
              i === activeIdx ? 'scale-[1.02] text-foreground' : i < activeIdx ? 'text-muted-foreground/40' : 'text-muted-foreground/70')}>
            {l.text || '♪'}
          </p>
        ))}
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
export function LyricsTicker({ artist, title, position, duration, onOpen, className }: {
  artist: string; title: string; position: number; duration?: number; onOpen: () => void; className?: string
}) {
  const { data } = useQuery({
    queryKey: ['music-lyrics', artist, title, duration], queryFn: () => getLyrics(artist, title, duration),
    enabled: !!title, staleTime: Infinity,
  })
  const synced = data?.synced ?? null
  const activeIdx = useActiveLyricIndex(synced, position)
  if (!synced?.length) return null

  // Before the first line's timestamp, activeIdx is -1 (nothing sung yet) - preview the song's
  // opening lines instead of centering on a nonexistent "active" line.
  const rows = activeIdx < 0 ? [synced[0], synced[1], synced[2]] : [synced[activeIdx - 1], synced[activeIdx], synced[activeIdx + 1]]
  const activeRow = activeIdx < 0 ? -1 : 1
  return (
    <button type="button" onClick={onOpen}
      className={cn('flex w-full flex-col justify-center gap-0.5 rounded-control bg-muted/50 px-3 py-1.5 text-left transition-colors hover:bg-muted', className)}>
      {rows.map((l, i) => (
        <p key={i} className={cn('truncate text-xs leading-snug',
          i === activeRow ? 'font-semibold text-foreground' : 'text-muted-foreground/60')}>
          {l ? (l.text || '♪') : ' '}
        </p>
      ))}
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
