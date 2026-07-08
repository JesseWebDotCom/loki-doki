import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Heart, Music2, SkipForward, SkipBack, Pause, Play, Download, Moon, Mic, Disc3, ListMusic, AudioLines, MonitorPlay, Maximize2 } from 'lucide-react'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { proxyImg } from '@/lib/img'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { Spinner } from '@/components/ui/spinner'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/cn'
import { useRadio } from '@/context/RadioContext'
import { EqVisualizer } from '@/components/shared/EqVisualizer'
import { getLyrics, getSongInfo, getArtistInfo, getSongSmartLinks, addFavorite, saveOffline, getStationTuning, getStation, prefetchMedia } from '@/lib/music/catalogApi'
import { useCatalogNav } from '@/lib/music/catalogNav'
import { usePlayerOverlay } from '@/context/PlayerOverlayContext'
import { SectionLabel, LyricsPanel, AboutStrip, SmartLinksRow } from '@/components/music/nowPlayingParts'
import { StarRating } from '@/components/music/StarRating'
import { TrackTechBadge } from '@/components/music/TrackTechBadge'
import { WaveformSeekBar } from '@/components/music/WaveformSeekBar'
import { isYouTubeRef } from '@/lib/music/trackRef'

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, '0')}`

// Generic fallback shown for the blink before the station's own lines load (or for legacy
// preset stations with no saved id). The per-station LLM-written set replaces these.
const FALLBACK_TUNING = [
  'Warming up the speakers…',
  'Lining up the perfect first track…',
  'Cueing something good…',
  'Finding the groove…',
]

// Fills the lyrics panel while a station spins up with a pulsing equalizer + rotating
// playful "tuning in" lines pulled from the station's stored, LLM-written set.
function TuningLyrics({ stationId, color }: { stationId?: string; color: string }) {
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

// The full-bleed player hero shell: blurred artwork backdrop over a forced-dark surface
// (the Moosic/Apple-Music look), independent of the app theme like NowPlayingOverlay.
function HeroShell({ backdropUrl, c1, children }: { backdropUrl: string | null; c1: string; children: React.ReactNode }) {
  return (
    <div data-theme="dark" className="relative overflow-hidden rounded-sheet bg-black shadow-lg">
      {backdropUrl && (
        <img src={backdropUrl} alt="" aria-hidden
          className="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-50 blur-3xl saturate-150" />
      )}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/30 via-black/55 to-black/85" />
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full opacity-20 blur-3xl" style={{ background: c1 }} />
      {children}
    </div>
  )
}

// Shown while a station is spinning up - queue is still building and the DJ intro is
// playing, so there's no track on deck yet. Mirrors the loaded layout with the real
// station identity so the wait reads as "tuning in", not "broken".
function NowPlayingSkeleton({ c1, c2, emoji, label, paused, getAnalyser, stationId, showViz, iconUrl, sourceBackLink }: {
  c1: string; c2: string; emoji: string; label: string; paused: boolean; getAnalyser: () => AnalyserNode | null; stationId?: string; showViz: boolean; iconUrl?: string; sourceBackLink?: { url: string; label: string } | null
}) {
  const navigate = useNavigate()
  return (
    <PageContainer width="full" className="pt-6 pb-8">
      <HeroShell backdropUrl={iconUrl ?? null} c1={c1}>
        {showViz && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3">
            <EqVisualizer active={!paused} getAnalyser={getAnalyser} color={c1} colorDark={c2} opacity={0.25} fade />
          </div>
        )}
        <div className="relative flex flex-col items-center px-6 pb-8 pt-5">
          <div className="mb-6 flex w-full flex-wrap items-center gap-2">
            {/* design-ok(glass-on-plain-bg) design-ok(backdrop-blur-outside-chrome): chips float over the blurred-art hero */}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-white/90 backdrop-blur">
              <span>{emoji}</span> {label}
            </span>
            {sourceBackLink && (
              <button onClick={() => navigate(sourceBackLink.url)}
                // design-ok(glass-on-plain-bg) design-ok(backdrop-blur-outside-chrome): chip floats over the blurred-art hero
                className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/70 backdrop-blur transition hover:bg-white/20 hover:text-white">
                ← {sourceBackLink.label}
              </button>
            )}
          </div>
          <div className="relative size-52 overflow-hidden rounded-card shadow-2xl ring-1 ring-white/15 md:size-60"
            style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
            <Disc3 className="absolute left-1/2 top-1/2 size-12 -translate-x-1/2 -translate-y-1/2 text-white/40 motion-safe:animate-[spin_6s_linear_infinite]" />
            {iconUrl && <img src={iconUrl} alt="" className="absolute inset-0 size-full object-cover" onError={e => { e.currentTarget.style.display = 'none' }} />}
          </div>
          <Skeleton className="mt-6 h-7 w-64 max-w-full" />
          <Skeleton className="mt-2 h-4 w-40" />
          <Skeleton className="mt-6 h-10 w-full max-w-xl" />
          <p className="mt-6 flex items-center gap-1.5 text-xs text-white/60">
            <Spinner size="sm" /> Tuning in…
          </p>
        </div>
      </HeroShell>

      {/* Lyrics + Up Next - same 60/40 grid, skeleton content. */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[3fr_2fr]">
        <section className="flex min-h-0 flex-col">
          <SectionLabel icon={Music2} color={c1}>Lyrics</SectionLabel>
          <Card className="relative h-[58vh] overflow-hidden">
            <TuningLyrics stationId={stationId} color={c1} />
          </Card>
        </section>
        <section className="flex min-h-0 flex-col">
          <SectionLabel icon={ListMusic} color={c1}>Up Next</SectionLabel>
          <Card className="h-[58vh] overflow-y-auto p-1.5">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-control px-2.5 py-2">
                <span className="w-4 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground/40">{i + 1}</span>
                <Skeleton className="size-10 shrink-0 rounded-control" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
              </div>
            ))}
          </Card>
        </section>
      </div>
    </PageContainer>
  )
}

export function NowPlayingPage() {
  const radio = useRadio()
  const navigate = useNavigate()
  const cat = useCatalogNav()
  const queryClient = useQueryClient()
  const { openPlayer } = usePlayerOverlay()

  // Warm the NEXT track's page content (image, lyrics, Wikipedia, smart links) into the
  // react-query cache *while the current song is still playing* - these all use staleTime:Infinity,
  // so when currentTrack flips after the DJ transition they render instantly instead of starting
  // their fetches only then (which read as the page "waiting" behind the DJ). The fetches all run
  // in parallel; if one is still in flight at transition time it just resolves - never serial to the DJ.
  const next = radio.nextTrack
  useEffect(() => {
    if (!next?.title) return
    const artist = next.author ?? ''
    const title = next.title
    const warm = (key: unknown[], fn: () => Promise<unknown>) =>
      void queryClient.prefetchQuery({ queryKey: key, queryFn: fn, staleTime: Infinity })
    warm(['music-lyrics', artist, title], () => getLyrics(artist, title))
    if (title) warm(['music-song-info', artist, title], () => getSongInfo(artist, title))
    if (artist) warm(['music-artist-info', artist], () => getArtistInfo(artist))
    if (artist && title) warm(['music-smart-links', artist, title], () => getSongSmartLinks(artist, title))
    if (next.thumbnail) { const img = new Image(); img.src = proxyImg(next.thumbnail) }   // warm the hero artwork
  }, [next?.videoId, next?.title, next?.author, next?.thumbnail, queryClient])
  // Once the queue is built, the first song is already cued and playing under the DJ intro
  // (currentTrack only gets set after the intro finishes). Fall back to that cued track so the
  // loading messages stop the moment the DJ kicks in, rather than lingering over the intro.
  const cur = radio.currentTrack ?? radio.queue[radio.index] ?? null

  // Prefetch the current song's VIDEO (480p) so switching to Watch is instant + same-spot. Only
  // for real stations (where the Watch button is shown), not one-off/instant track sessions.
  const watchableStation = radio.station?.stationId
  useEffect(() => {
    if (cur?.videoId && watchableStation && isYouTubeRef(cur.videoId)) void prefetchMedia(cur.videoId, 'video', 480)
  }, [cur?.videoId, watchableStation])

  // Fast path: sourceRef is carried in the DjStation shape so it's available immediately.
  // Fallback: fetch from DB for stations started before sourceRef was added to DjStation.
  const { data: stationDetail } = useQuery({
    queryKey: ['station', watchableStation],
    queryFn: () => getStation(watchableStation!),
    enabled: !!watchableStation && !radio.station?.sourceRef,
    staleTime: Infinity,
  })
  const sourceRef = radio.station?.sourceRef ?? stationDetail?.station.sourceRef ?? ''
  const sourceBackLink = (() => {
    const movieM = sourceRef.match(/^source:movie:(.+)$/)
    if (movieM) return { url: `/movies/${movieM[1]}`, label: decodeURIComponent(movieM[1]) }
    const showM = sourceRef.match(/^source:show:(\d+):(.+)$/)
    if (showM) return { url: `/shows/${showM[1]}`, label: decodeURIComponent(showM[2]) }
    return null
  })()

  // Nothing started yet - the only genuinely empty state.
  if (!radio.active) {
    return <PageContainer width="wide"><PageHeader plain title="Now Playing" subtitle="Start a station to see lyrics, info, and what's up next." /></PageContainer>
  }

  // design-ok(hex-in-tsx): station accent fallbacks (brand hues) - interpolated with alpha suffixes below
  const c1 = radio.station?.color ?? '#a192ff'
  const c2 = radio.station?.colorDark ?? '#643fd1' // design-ok(hex-in-tsx): station accent fallback (brand hue)
  const emoji = radio.station?.emoji ?? '📻'
  const label = radio.station?.label ?? 'Radio'

  // Station is starting (queue building + DJ intro) but no track is on deck yet -
  // show the loading skeleton instead of the "nothing's playing" copy.
  if (!cur) {
    return <NowPlayingSkeleton c1={c1} c2={c2} emoji={emoji} label={label} paused={radio.paused} getAnalyser={radio.getAnalyser} stationId={radio.station?.stationId} showViz={radio.visualizerEnabled} iconUrl={radio.station?.iconUrl} sourceBackLink={sourceBackLink} />
  }

  const artist = cur.author ?? ''
  const upNext = radio.queue.slice(radio.index + 1, radio.index + 25)
  // While the station spins up, the DJ intro is still being written/synthesized. Keep the "tuning
  // in" messages over the lyrics (which load behind) until the DJ is about to speak, rather than
  // flashing empty/half-loaded lyrics first.
  const djPending = radio.phase === 'intro' && !radio.djSpeaking
  const canSeek = radio.phase === 'playing' && !radio.djSpeaking && radio.durationSec > 0
  const isYt = isYouTubeRef(cur.videoId)

  const favorite = async () => {
    try { await addFavorite({ kind: 'song', refId: cur.videoId, title: cur.title, artist }); toast.success('Added to favorites') }
    catch { toast.error('Could not favorite') }
  }
  const download = async () => {
    try { const r = await saveOffline({ videoId: cur.videoId, title: cur.title }); toast.success(r.status === 'already-saved' ? 'Already saved offline' : 'Saving for offline…') }
    catch { toast.error('Could not save offline') }
  }

  // design-ok(glass-on-plain-bg): utility buttons float over the blurred-art hero (forced-dark surface)
  const utilBtn = 'flex size-9 items-center justify-center rounded-full text-white/60 transition hover:bg-white/10 hover:text-white'

  return (
    <PageContainer width="full" className="pt-6 pb-8">
      {/* Player hero - full-bleed blurred artwork over a forced-dark surface. */}
      <HeroShell backdropUrl={cur.thumbnail ? proxyImg(cur.thumbnail) : null} c1={c1}>
        {radio.visualizerEnabled && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3">
            <EqVisualizer active={!radio.paused} getAnalyser={radio.getAnalyser} color={c1} colorDark={c2} opacity={0.25} fade />
          </div>
        )}
        <div className="relative flex flex-col items-center px-6 pb-7 pt-5">
          {/* Station identity row */}
          <div className="mb-5 flex w-full flex-wrap items-center gap-2">
            {/* design-ok(glass-on-plain-bg) design-ok(backdrop-blur-outside-chrome): chips float over the blurred-art hero */}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest text-white/90 backdrop-blur">
              <span>{emoji}</span> {label}
            </span>
            {sourceBackLink && (
              <button onClick={() => navigate(sourceBackLink.url)}
                // design-ok(glass-on-plain-bg) design-ok(backdrop-blur-outside-chrome): chip floats over the blurred-art hero
                className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/70 backdrop-blur transition hover:bg-white/20 hover:text-white">
                ← {sourceBackLink.label}
              </button>
            )}
            {radio.sleepAtMs && (
              <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-white/60">
                <Moon className="size-3" /> stopping in ~{Math.max(0, Math.round((radio.sleepAtMs - Date.now()) / 60000))} min
              </span>
            )}
          </div>

          {/* Artwork */}
          <div className="relative size-52 shrink-0 overflow-hidden rounded-card shadow-2xl ring-1 ring-white/15 md:size-64"
            style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
            <Disc3 className={cn('absolute left-1/2 top-1/2 size-12 -translate-x-1/2 -translate-y-1/2 text-white/40', !radio.paused && 'motion-safe:animate-[spin_6s_linear_infinite]')} />
            <img src={proxyImg(cur.thumbnail)} alt="" className="relative size-full object-cover"
              onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
          </div>

          {/* Title / artist - big, centered, clickable through to catalog pages. */}
          <button onClick={() => cat.openSong(cur.title, artist)} disabled={cat.pending === 'song'}
            className="mt-6 max-w-2xl truncate text-center text-2xl font-bold tracking-tight text-white transition hover:text-white/80 disabled:opacity-60 md:text-3xl"
            title="View album details">{cur.title}</button>
          {artist && (
            <button onClick={() => cat.openArtist(artist)} disabled={cat.pending === 'artist'}
              className="mt-1 max-w-xl truncate text-center text-base text-white/60 transition hover:text-white disabled:opacity-60"
              title="View artist details">{artist}</button>
          )}

          {/* Heart · stars row */}
          <div className="mt-4 flex items-center gap-6">
            <button onClick={favorite} aria-label="Favorite" className={utilBtn}>
              <Heart className="size-5" />
            </button>
            <StarRating trackRef={cur.videoId} title={cur.title} artist={artist} />
            {isYt && (
              <button onClick={download} aria-label="Save offline" className={utilBtn}>
                <Download className="size-5" />
              </button>
            )}
          </div>

          {/* Waveform seek + clocks */}
          <div className="mt-5 w-full max-w-2xl">
            <WaveformSeekBar trackRef={cur.videoId} pos={radio.positionSec} total={radio.durationSec}
              // design-ok(hex-in-tsx): white seek accent over the forced-dark hero (same as the overlay player)
              onSeek={radio.seek} accent="#ffffff" disabled={!canSeek} />
            <div className="mt-1 flex items-center justify-between text-[11px] tabular-nums text-white/50">
              <span>{fmtClock(radio.positionSec)}</span>
              <span>-{fmtClock(Math.max(0, radio.durationSec - radio.positionSec))}</span>
            </div>
          </div>

          {/* Codec / lossless pill */}
          <TrackTechBadge trackRef={cur.videoId} className="mt-1" />

          {/* Transport */}
          <div className="mt-4 flex items-center gap-8">
            <button onClick={() => radio.seek(0)} aria-label="Restart song"
              className="text-white/70 transition hover:text-white active:scale-95">
              <SkipBack className="size-8 fill-current" />
            </button>
            <button onClick={() => radio.togglePause()} aria-label="Play/pause"
              className="flex size-16 items-center justify-center text-white transition hover:scale-105 active:scale-95">
              {radio.paused ? <Play className="size-14 translate-x-0.5 fill-current" /> : <Pause className="size-14 fill-current" />}
            </button>
            <button onClick={() => radio.skip()} disabled={radio.skipping} aria-label="Skip"
              className="text-white/70 transition hover:text-white active:scale-95 disabled:opacity-50">
              {radio.skipping ? <Spinner className="size-8 text-current" /> : <SkipForward className="size-8 fill-current" />}
            </button>
          </div>

          {/* Utility row */}
          <div className="mt-5 flex items-center gap-2">
            {isYt && (
              <button onClick={() => navigate(radio.station?.stationId ? `/music/watch/${radio.station.stationId}` : '/music/watch/current')}
                aria-label="Watch video" title="Switch to video - same song, same spot" className={utilBtn}>
                <MonitorPlay className="size-4" />
              </button>
            )}
            <button onClick={radio.toggleVisualizer} className={cn(utilBtn, !radio.visualizerEnabled && 'text-white/30')}
              aria-label={radio.visualizerEnabled ? 'Hide visualizer' : 'Show visualizer'}
              title={radio.visualizerEnabled ? 'Visualizer on' : 'Visualizer off'}>
              <AudioLines className="size-4" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className={cn(utilBtn, (radio.station?.djMode ?? 'full') === 'silent' && 'text-white/30')}
                  aria-label="DJ mode" title={`DJ: ${radio.station?.djMode ?? 'full'}`}>
                  <Mic className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                {([['full', 'Full DJ'], ['minimal', 'DJ minimal'], ['silent', 'Silent (no DJ)']] as const).map(([mode, modeLabel]) => (
                  <DropdownMenuItem key={mode} onClick={() => radio.setDjMode(mode)}>
                    {(radio.station?.djMode ?? 'full') === mode ? '✓ ' : ''}{modeLabel}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className={cn(utilBtn, radio.sleepAtMs && 'text-white')} aria-label="Sleep timer"><Moon className="size-4" /></button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                {[15, 30, 45, 60].map(m => <DropdownMenuItem key={m} onClick={() => radio.setSleep(m)}>Stop in {m} minutes</DropdownMenuItem>)}
                {radio.sleepAtMs && <DropdownMenuItem onClick={() => radio.setSleep(null)}>Turn off timer</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
            <button onClick={() => openPlayer()} aria-label="Fullscreen player" title="Fullscreen player" className={utilBtn}>
              <Maximize2 className="size-4" />
            </button>
          </div>
        </div>
      </HeroShell>

      <AboutStrip artist={artist} title={cur.title} color={c1} />
      <SmartLinksRow artist={artist} title={cur.title} color={c1} />

      {/* No tabs - lyrics and what's up next are both always visible (60 / 40). */}
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[3fr_2fr]">
        <section className="flex min-h-0 flex-col">
          <SectionLabel icon={Music2} color={c1}>Lyrics</SectionLabel>
          <Card className="relative h-[58vh]">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 rounded-t-card bg-gradient-to-b from-card to-transparent" />
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 rounded-b-card bg-gradient-to-t from-card to-transparent" />
            <LyricsPanel artist={artist} title={cur.title} />
            {djPending && (
              <div className="absolute inset-0 z-20 rounded-card bg-card animate-in fade-in">
                <TuningLyrics stationId={radio.station?.stationId} color={c1} />
              </div>
            )}
          </Card>
        </section>
        <section className="flex min-h-0 flex-col">
          <SectionLabel icon={ListMusic} color={c1}>Up Next</SectionLabel>
          <Card className="h-[58vh] overflow-y-auto p-1.5">
            {upNext.length === 0 && !radio.queueLoading && (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                <ListMusic className="size-7 opacity-30" />
                <p className="text-sm">Nothing queued.</p>
              </div>
            )}
            {upNext.map((t, i) => (
              <div key={t.videoId + i} className="group flex items-center gap-3 rounded-control px-2.5 py-2 transition-colors hover:bg-foreground/[0.04]">
                <span className="w-4 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground/50">{i + 1}</span>
                <img src={proxyImg(t.thumbnail)} alt="" className="size-10 shrink-0 rounded-control object-cover ring-1 ring-border/50"
                  onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.title}</p>
                  {t.author && <p className="truncate text-xs text-muted-foreground">{t.author}</p>}
                </div>
              </div>
            ))}
            {/* The station starts on its first track while the rest of the queue builds in the
                background - show skeleton rows so the short list doesn't read as "that's all". */}
            {radio.queueLoading && (
              <>
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={`ph-${i}`} className="flex items-center gap-3 rounded-control px-2.5 py-2">
                    <span className="w-4 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground/30">{upNext.length + i + 1}</span>
                    <Skeleton className="size-10 shrink-0 rounded-control" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-3/4" />
                      <Skeleton className="h-3 w-2/5" />
                    </div>
                  </div>
                ))}
                <p className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
                  <Spinner size="sm" />
                  Building the rest of the station…
                </p>
              </>
            )}
          </Card>
        </section>
      </div>
    </PageContainer>
  )
}
