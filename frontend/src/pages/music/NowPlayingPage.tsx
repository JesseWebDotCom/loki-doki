import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Heart, ExternalLink, Music2, SkipForward, Pause, Play, Download, Moon, Mic, Disc3, Info, ListMusic } from 'lucide-react'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { proxyImg } from '@/lib/img'
import { PageHeader } from '@/components/shared/PageHeader'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { useRadio } from '@/context/RadioContext'
import { EqVisualizer } from '@/components/shared/EqVisualizer'
import { getLyrics, getSongInfo, getArtistInfo, addFavorite, saveOffline } from '@/lib/music/catalogApi'

function SectionLabel({ icon: Icon, color, children }: { icon: typeof Music2; color: string; children: React.ReactNode }) {
  return (
    <h2 className="mb-2.5 flex items-center gap-2 text-sm font-bold">
      <span className="flex size-6 items-center justify-center rounded-lg" style={{ background: `${color}26` }}>
        <Icon className="size-3.5" style={{ color }} />
      </span>
      {children}
    </h2>
  )
}

function LyricsPanel({ artist, title }: { artist: string; title: string }) {
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
  return empty('No lyrics found for this track.')
}

// One concise paragraph of fun facts about the song (preferred) or the artist, with a link to the
// full source. Sits above the lyrics/up-next columns so there are no tabs to dig through.
function AboutStrip({ artist, title, color }: { artist: string; title: string; color: string }) {
  const { data: song } = useQuery({ queryKey: ['music-song-info', artist, title], queryFn: () => getSongInfo(artist, title), enabled: !!title, staleTime: Infinity })
  const { data: art } = useQuery({ queryKey: ['music-artist-info', artist], queryFn: () => getArtistInfo(artist), enabled: !!artist, staleTime: Infinity })

  const pick = song?.found && song.extract
    ? { extract: song.extract, url: song.url, label: 'About this song' }
    : art?.found && art.extract
      ? { extract: art.extract, url: art.url, label: `About ${art.title ?? artist}` }
      : null
  if (!pick) return null

  return (
    <Card className="mt-4 border-l-[3px] bg-card/60 px-4 py-3" style={{ borderLeftColor: color }}>
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

export function NowPlayingPage() {
  const radio = useRadio()
  const cur = radio.currentTrack

  if (!radio.active || !cur) {
    return <div className="px-5 pt-6"><PageHeader variant="plain" className="!px-0 !pt-0 !pb-5" eyebrow="Music" title="Now Playing" subtitle="Start a station to see lyrics, info, and what's up next." /></div>
  }
  const artist = cur.author ?? ''
  const upNext = radio.queue.slice(radio.index + 1, radio.index + 25)
  const c1 = radio.station?.color ?? '#7c3aed'
  const c2 = radio.station?.colorDark ?? '#4c1d95'
  const emoji = radio.station?.emoji ?? '📻'

  const favorite = async () => {
    try { await addFavorite({ kind: 'song', refId: cur.videoId, title: cur.title, artist }); toast.success('Added to favorites') }
    catch { toast.error('Could not favorite') }
  }
  const download = async () => {
    try { const r = await saveOffline({ videoId: cur.videoId, title: cur.title }); toast.success(r.status === 'already-saved' ? 'Already saved offline' : 'Saving for offline…') }
    catch { toast.error('Could not save offline') }
  }

  return (
    <div className="px-5 pt-6 pb-8">
      {/* Hero — tinted with the station's accent colour for depth and identity. */}
      <div className="relative overflow-hidden rounded-2xl border border-border/50 p-5 shadow-lg"
        style={{ background: `linear-gradient(135deg, ${c1}24, ${c2}0a 65%)` }}>
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full opacity-25 blur-3xl" style={{ background: c1 }} />
        {/* Live faux-EQ band across the bottom of the hero — same engine as the mini-player. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2">
          <EqVisualizer active={!radio.paused} getAnalyser={radio.getAnalyser} color={c1} colorDark={c2} opacity={0.28} fade />
        </div>
        <div className="relative flex items-center gap-5">
          <div className="relative size-24 shrink-0 overflow-hidden rounded-2xl shadow-2xl ring-1 ring-white/15"
            style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
            <Disc3 className={cn('absolute left-1/2 top-1/2 size-10 -translate-x-1/2 -translate-y-1/2 text-white/40', !radio.paused && 'motion-safe:animate-[spin_6s_linear_infinite]')} />
            <img src={proxyImg(cur.thumbnail)} alt="" className="relative size-full object-cover"
              onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-white/90 backdrop-blur">
                <span>{emoji}</span> {radio.station?.label ?? 'Radio'}
              </span>
            </div>
            <h1 className="mt-2 truncate text-3xl font-black tracking-tight">{cur.title}</h1>
            {artist && <p className="mt-0.5 truncate text-sm text-muted-foreground">{artist}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="icon" variant="secondary" onClick={favorite} aria-label="Favorite"><Heart className="size-4" /></Button>
            <Button size="icon" variant="secondary" onClick={download} aria-label="Save offline"><Download className="size-4" /></Button>
            <button onClick={() => radio.togglePause()} aria-label="Play/pause"
              className="flex size-12 items-center justify-center rounded-full text-white shadow-lg transition hover:scale-105 active:scale-95"
              style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
              {radio.paused ? <Play className="size-5 translate-x-px fill-current" /> : <Pause className="size-5 fill-current" />}
            </button>
            <Button size="icon" variant="secondary" onClick={() => radio.skip()} aria-label="Skip"><SkipForward className="size-4" /></Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="secondary" aria-label="DJ mode" title={`DJ: ${radio.station?.djMode ?? 'full'}`}>
                  <Mic className={cn('size-4', (radio.station?.djMode ?? 'full') === 'silent' && 'text-muted-foreground/40')} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {([['full', 'Full DJ'], ['minimal', 'DJ minimal'], ['silent', 'Silent (no DJ)']] as const).map(([mode, label]) => (
                  <DropdownMenuItem key={mode} onClick={() => radio.setDjMode(mode)}>
                    {(radio.station?.djMode ?? 'full') === mode ? '✓ ' : ''}{label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant={radio.sleepAtMs ? 'default' : 'secondary'} aria-label="Sleep timer"><Moon className="size-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {[15, 30, 45, 60].map(m => <DropdownMenuItem key={m} onClick={() => radio.setSleep(m)}>Stop in {m} minutes</DropdownMenuItem>)}
                {radio.sleepAtMs && <DropdownMenuItem onClick={() => radio.setSleep(null)}>Turn off timer</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {radio.sleepAtMs && (
          <p className="relative mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Moon className="size-3" /> Sleep timer: stopping in about {Math.max(0, Math.round((radio.sleepAtMs - Date.now()) / 60000))} min
          </p>
        )}
      </div>

      <AboutStrip artist={artist} title={cur.title} color={c1} />

      {/* No tabs — lyrics and what's up next are both always visible (60 / 40). */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[3fr_2fr]">
        <section className="flex min-h-0 flex-col">
          <SectionLabel icon={Music2} color={c1}>Lyrics</SectionLabel>
          <Card className="relative h-[58vh]">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 rounded-t-2xl bg-gradient-to-b from-card to-transparent" />
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 rounded-b-2xl bg-gradient-to-t from-card to-transparent" />
            <LyricsPanel artist={artist} title={cur.title} />
          </Card>
        </section>
        <section className="flex min-h-0 flex-col">
          <SectionLabel icon={ListMusic} color={c1}>Up Next</SectionLabel>
          <Card className="h-[58vh] overflow-y-auto p-1.5">
            {upNext.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                <ListMusic className="size-7 opacity-30" />
                <p className="text-sm">Nothing queued.</p>
              </div>
            )}
            {upNext.map((t, i) => (
              <div key={t.videoId + i} className="group flex items-center gap-3 rounded-xl px-2.5 py-2 transition-colors hover:bg-foreground/[0.04]">
                <span className="w-4 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground/50">{i + 1}</span>
                <img src={proxyImg(t.thumbnail)} alt="" className="size-10 shrink-0 rounded-lg object-cover ring-1 ring-border/50"
                  onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  {t.author && <p className="truncate text-xs text-muted-foreground">{t.author}</p>}
                </div>
              </div>
            ))}
          </Card>
        </section>
      </div>
    </div>
  )
}
