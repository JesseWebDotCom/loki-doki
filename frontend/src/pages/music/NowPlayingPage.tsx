import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Heart, ExternalLink, Music2, SkipForward, Pause, Play, Download, Moon, Mic, Disc3 } from 'lucide-react'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { proxyImg } from '@/lib/img'
import { PageHeader } from '@/components/shared/PageHeader'
import { AppTabBar, type AppTab } from '@/components/shared/AppTabBar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { useRadio } from '@/context/RadioContext'
import { getLyrics, getSongInfo, getArtistInfo, addFavorite, saveOffline } from '@/lib/music/catalogApi'

type Tab = 'lyrics' | 'about' | 'queue'
const TABS: AppTab<Tab>[] = [
  { id: 'lyrics', label: 'Lyrics', icon: Music2 },
  { id: 'about', label: 'About', icon: ExternalLink },
  { id: 'queue', label: 'Up Next', icon: SkipForward },
]

function LyricsTab({ artist, title }: { artist: string; title: string }) {
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

  if (isLoading) return <p className="py-8 text-center text-sm text-muted-foreground">Looking for lyrics…</p>
  if (synced?.length) {
    return (
      <div ref={containerRef} className="relative max-h-[60vh] space-y-1 overflow-y-auto px-1 py-2">
        {synced.map((l, i) => (
          <p key={i} ref={i === activeIdx ? activeRef : undefined}
            className={cn('text-lg font-semibold leading-snug transition-colors',
              i === activeIdx ? 'text-foreground' : i < activeIdx ? 'text-muted-foreground/50' : 'text-muted-foreground/80')}>
            {l.text || '♪'}
          </p>
        ))}
      </div>
    )
  }
  if (data?.plain) {
    return <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap py-2 text-sm leading-relaxed text-foreground/90">{data.plain}</div>
  }
  return <p className="py-8 text-center text-sm text-muted-foreground">No lyrics found for this track.</p>
}

function AboutTab({ artist, title }: { artist: string; title: string }) {
  const { data: song } = useQuery({ queryKey: ['music-song-info', artist, title], queryFn: () => getSongInfo(artist, title), enabled: !!title, staleTime: Infinity })
  const { data: art } = useQuery({ queryKey: ['music-artist-info', artist], queryFn: () => getArtistInfo(artist), enabled: !!artist, staleTime: Infinity })
  return (
    <div className="space-y-5 py-2">
      {song?.found && song.extract && (
        <section>
          <h3 className="mb-1 text-sm font-bold">About the song</h3>
          <p className="text-sm leading-relaxed text-muted-foreground">{song.extract}</p>
          {song.url && <a href={song.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-brand hover:underline"><ExternalLink className="size-3" /> Wikipedia</a>}
        </section>
      )}
      {art?.found && (
        <section>
          <h3 className="mb-1 text-sm font-bold">About {art.title ?? artist}</h3>
          <div className="flex gap-3">
            {art.image && <img src={proxyImg(art.image)} alt="" className="size-20 shrink-0 rounded-lg object-cover" />}
            <div>
              <p className="text-sm leading-relaxed text-muted-foreground line-clamp-6">{art.extract}</p>
              {art.url && <a href={art.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-brand hover:underline"><ExternalLink className="size-3" /> Wikipedia</a>}
            </div>
          </div>
        </section>
      )}
      {!song?.found && !art?.found && <p className="py-8 text-center text-sm text-muted-foreground">No background info found.</p>}
    </div>
  )
}

export function NowPlayingPage() {
  const radio = useRadio()
  const [tab, setTab] = useState<Tab>('lyrics')
  const cur = radio.currentTrack

  if (!radio.active || !cur) {
    return <div className="px-5 pt-6"><PageHeader variant="plain" className="!px-0 !pt-0 !pb-5" eyebrow="Music" title="Now Playing" subtitle="Start a station to see lyrics, info, and what's up next." /></div>
  }
  const artist = cur.author ?? ''
  const upNext = radio.queue.slice(radio.index + 1, radio.index + 25)

  const favorite = async () => {
    try { await addFavorite({ kind: 'song', refId: cur.videoId, title: cur.title, artist }); toast.success('Added to favorites') }
    catch { toast.error('Could not favorite') }
  }
  const download = async () => {
    try { const r = await saveOffline({ videoId: cur.videoId, title: cur.title }); toast.success(r.status === 'already-saved' ? 'Already saved offline' : 'Saving for offline…') }
    catch { toast.error('Could not save offline') }
  }

  return (
    <div className="px-5 pt-6">
      <div className="flex items-center gap-4">
        <div className="relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-brand/30 to-brand/10 shadow">
          <Disc3 className="absolute size-8 text-brand/60" />
          <img src={proxyImg(cur.thumbnail)} alt="" className="relative size-full object-cover"
            onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{radio.station?.label ?? 'Radio'}</p>
          <h1 className="truncate text-2xl font-black tracking-tight">{cur.title}</h1>
          {artist && <p className="truncate text-sm text-muted-foreground">{artist}</p>}
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="icon" variant="secondary" onClick={favorite} aria-label="Favorite"><Heart className="size-4" /></Button>
          <Button size="icon" variant="secondary" onClick={download} aria-label="Save offline"><Download className="size-4" /></Button>
          <Button size="icon" variant="secondary" onClick={() => radio.togglePause()} aria-label="Play/pause">{radio.paused ? <Play className="size-4 fill-current" /> : <Pause className="size-4" />}</Button>
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
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Moon className="size-3" /> Sleep timer: stopping in about {Math.max(0, Math.round((radio.sleepAtMs - Date.now()) / 60000))} min
        </p>
      )}

      <AppTabBar tabs={TABS} value={tab} onChange={setTab} className="my-4" />
      {tab === 'lyrics' && <LyricsTab artist={artist} title={cur.title} />}
      {tab === 'about' && <AboutTab artist={artist} title={cur.title} />}
      {tab === 'queue' && (
        <div className="divide-y divide-border/50 rounded-xl border border-border/60">
          {upNext.length === 0 && <p className="px-3 py-4 text-sm text-muted-foreground">Nothing queued.</p>}
          {upNext.map((t, i) => (
            <div key={t.videoId + i} className="flex items-center gap-3 px-3 py-2.5">
              <img src={proxyImg(t.thumbnail)} alt="" className="size-9 shrink-0 rounded object-cover" />
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{t.title}</p>{t.author && <p className="truncate text-xs text-muted-foreground">{t.author}</p>}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
