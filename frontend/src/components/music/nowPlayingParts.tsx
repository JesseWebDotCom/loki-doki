import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Info, Music2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { useRadio } from '@/context/RadioContext'
import { getLyrics, getSongInfo, getArtistInfo, getSongSmartLinks } from '@/lib/music/catalogApi'

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

// Synced (or plain) lyrics that auto-scroll the active line, driven by radio.positionSec.
export function LyricsPanel({ artist, title }: { artist: string; title: string }) {
  const radio = useRadio()
  const { data, isLoading } = useQuery({
    queryKey: ['music-lyrics', artist, title], queryFn: () => getLyrics(artist, title),
    enabled: !!title, staleTime: Infinity,
  })
  const synced = data?.synced ?? null
  const containerRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLParagraphElement>(null)

  const activeIdx = useMemo(() => {
    if (!synced) return -1
    let idx = -1
    for (let i = 0; i < synced.length; i++) { if (synced[i]!.sec <= radio.positionSec + 0.3) idx = i; else break }
    return idx
  }, [synced, radio.positionSec])

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
            className={cn('text-lg font-semibold leading-snug transition-all duration-300',
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

// One concise paragraph of fun facts about the song (preferred) or the artist, with a link to
// the full source.
export function AboutStrip({ artist, title, color }: { artist: string; title: string; color: string }) {
  const { data: song } = useQuery({ queryKey: ['music-song-info', artist, title], queryFn: () => getSongInfo(artist, title), enabled: !!title, staleTime: Infinity })
  const { data: art } = useQuery({ queryKey: ['music-artist-info', artist], queryFn: () => getArtistInfo(artist), enabled: !!artist, staleTime: Infinity })

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
