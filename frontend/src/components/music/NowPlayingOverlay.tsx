import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  ChevronDown, Heart, Download, MonitorPlay, Play, Pause, SkipForward, AudioLines,
  Mic, Moon, Volume2, VolumeX, ListMusic, Music2, Disc3,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { fmtClock } from '@/lib/youtube/format'
import { useRadio } from '@/context/RadioContext'
import { usePlayerOverlay } from '@/context/PlayerOverlayContext'
import { useCatalogNav } from '@/lib/music/catalogNav'
import { EqVisualizer } from '@/components/shared/EqVisualizer'
import { StarRating } from '@/components/music/StarRating'
import { SongArt, useSongArt } from '@/components/music/SongArt'
import { TrackTechBadge } from '@/components/music/TrackTechBadge'
import { WaveformSeekBar } from '@/components/music/WaveformSeekBar'
import { Spinner } from '@/components/ui/spinner'
import { Skeleton } from '@/components/ui/skeleton'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { LyricsPanel, AboutStrip, SmartLinksRow, SectionLabel } from './nowPlayingParts'
import { addFavorite, saveOffline } from '@/lib/music/catalogApi'

type Tab = 'lyrics' | 'up-next' | 'about'

// The app-wide, immersive "full page" player (Apple Music / Plexamp style). It reuses the
// existing playback engine wholesale via useRadio() (no engine changes). Raised from the
// mini-player bar (or the rail / a deep link) and dismissed by dragging down or the chevron;
// the audio keeps playing underneath either way.
export function NowPlayingOverlay() {
  const { open, closePlayer } = usePlayerOverlay()
  const radio = useRadio()
  const navigate = useNavigate()
  const cat = useCatalogNav()
  const [tab, setTab] = useState<Tab>('lyrics')

  // Drag-down-to-dismiss (touch). Tracks the pointer on the top grab area only, so the
  // scrollable tab content underneath still scrolls normally.
  const [dragY, setDragY] = useState(0)
  const dragStart = useRef<number | null>(null)
  const onDragStart = useCallback((e: React.PointerEvent) => { dragStart.current = e.clientY }, [])
  const onDragMove = useCallback((e: React.PointerEvent) => {
    if (dragStart.current == null) return
    setDragY(Math.max(0, e.clientY - dragStart.current))
  }, [])
  const onDragEnd = useCallback(() => {
    if (dragStart.current == null) return
    dragStart.current = null
    setDragY(y => { if (y > 120) closePlayer(); return 0 })
  }, [closePlayer])

  const curForArt = radio.currentTrack ?? radio.queue[radio.index] ?? null
  // Unconditional hook (before the early return): real square album art for cover + backdrop.
  const overlayArt = useSongArt(curForArt?.videoId, curForArt?.title, curForArt?.author)

  if (!open) return null

  const cur = curForArt
  // design-ok(hex-in-tsx): station accent fallbacks (brand hues) - canvas/gradient literals
  const c1 = radio.station?.color ?? '#a192ff'
  const c2 = radio.station?.colorDark ?? '#643fd1'
  const emoji = radio.station?.emoji ?? '📻'
  const artist = cur?.author ?? ''
  const canSeek = radio.phase === 'playing' && !radio.djSpeaking && radio.durationSec > 0
  const upNext = radio.queue.slice(radio.index + 1, radio.index + 25)

  const favorite = async () => {
    if (!cur) return
    try { await addFavorite({ kind: 'song', refId: cur.videoId, title: cur.title, artist }); toast.success('Added to favorites') }
    catch { toast.error('Could not favorite') }
  }
  const download = async () => {
    if (!cur) return
    try { const r = await saveOffline({ videoId: cur.videoId, title: cur.title }); toast.success(r.status === 'already-saved' ? 'Already saved offline' : 'Saving for offline…') }
    catch { toast.error('Could not save offline') }
  }

  return createPortal(
    // design-ok(raw-overlay): full-screen immersive player; deliberately not ui/dialog (drag-to-
    // dismiss + must not focus-trap over the hands-free companion). Same rationale as PlexPlayer.
    // Portaled to <body> so it covers the app's left sidebar too (a nested mount would sit inside
    // the right column's stacking context and paint under the sidebar).
    <div
      data-theme="dark"
      className="fixed inset-0 z-[100] flex flex-col text-white"
      style={{ transform: dragY ? `translateY(${dragY}px)` : undefined, transition: dragY ? 'none' : 'transform 0.25s ease' }}
    >
      {/* Backdrop: blurred cover art + station-accent gradient wash */}
      <div className="absolute inset-0 -z-10 bg-black">
        {(overlayArt || cur?.thumbnail) && (
          <img src={overlayArt ?? proxyImg(cur!.thumbnail)} alt="" className="absolute inset-0 size-full scale-125 object-cover opacity-40 blur-2xl" />
        )}
        <div className="absolute inset-0" style={{ background: `linear-gradient(160deg, ${c1}55, ${c2}cc 55%, rgba(10,10,12,0.96))` }} />
      </div>

      {/* Ambient EQ across the very bottom */}
      {radio.visualizerEnabled && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40">
          <EqVisualizer active={!radio.paused} getAnalyser={radio.getAnalyser} color={c1} colorDark={c2} opacity={0.3} fade />
        </div>
      )}

      {/* Grab / header row (drag target) */}
      <div
        className="shrink-0 touch-none pt-safe"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-white/30" />
        <div className="flex items-center justify-between px-4 py-2">
          <button onClick={closePlayer} aria-label="Close player" className="grid size-9 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white">
            <ChevronDown className="size-6" />
          </button>
          <span className="inline-flex items-center gap-1.5 truncate rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-white/90">
            <span>{emoji}</span> {radio.station?.label ?? 'AI Radio'}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button aria-label="Sleep timer" className="grid size-9 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white">
                <Moon className={cn('size-5', radio.sleepAtMs && 'text-white')} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {[15, 30, 45, 60].map(m => <DropdownMenuItem key={m} onClick={() => radio.setSleep(m)}>Stop in {m} minutes</DropdownMenuItem>)}
              {radio.sleepAtMs && <DropdownMenuItem onClick={() => radio.setSleep(null)}>Turn off timer</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Player column */}
      <div className="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col px-6 pb-safe">
        {/* Cover art */}
        <div className="mt-2 flex justify-center">
          <div className="relative aspect-square w-full max-w-[min(70vw,340px)] overflow-hidden rounded-sheet shadow-2xl ring-1 ring-white/15"
            style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>
            <Disc3 className={cn('absolute left-1/2 top-1/2 size-16 -translate-x-1/2 -translate-y-1/2 text-white/30', !radio.paused && 'motion-safe:animate-[spin_8s_linear_infinite]')} />
            {(overlayArt || cur?.thumbnail) && (
              <img src={overlayArt ?? proxyImg(cur!.thumbnail)} alt="" className="relative size-full object-cover"
                onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
            )}
            {radio.djSpeaking && (
              <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[11px] font-medium">
                <Mic className="size-3" /> On the mic
              </span>
            )}
          </div>
        </div>

        {/* Title / artist */}
        <div className="mt-5 min-w-0 text-center">
          <button onClick={() => cur && cat.openSong(cur.title, artist)} disabled={!cur || cat.pending === 'song'}
            className="block w-full truncate text-xl font-bold transition hover:text-white/80 disabled:opacity-70"
            title="View album details">{cur?.title ?? 'AI Radio'}</button>
          {artist && (
            <button onClick={() => cat.openArtist(artist)} disabled={cat.pending === 'artist'}
              className="mt-1 block w-full truncate text-sm text-white/70 transition hover:text-white hover:underline disabled:opacity-60"
              title="View artist details">{artist}</button>
          )}
          {cur && <StarRating trackRef={cur.videoId} title={cur.title} artist={artist} size="sm" className="mt-2 justify-center" />}
        </div>

        {/* Seek: the track's real waveform when scanned, plain track otherwise */}
        <div className="mt-3">
          {cur ? (
            <WaveformSeekBar trackRef={cur.videoId} pos={radio.positionSec} total={radio.durationSec}
              onSeek={radio.seek} accent="#ffffff" disabled={!canSeek} />
          ) : null}
          <div className="mt-1 flex items-center justify-between text-[11px] tabular-nums text-white/60">
            <span>{fmtClock(radio.positionSec)}</span>
            {cur && <TrackTechBadge trackRef={cur.videoId} />}
            <span>{radio.durationSec > 0 ? `-${fmtClock(Math.max(0, radio.durationSec - radio.positionSec))}` : '--:--'}</span>
          </div>
        </div>

        {/* Transport */}
        <div className="mt-3 flex items-center justify-center gap-5">
          <button onClick={favorite} aria-label="Favorite" className="grid size-10 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white">
            <Heart className="size-5" />
          </button>
          <button onClick={() => radio.togglePause()} aria-label={radio.paused ? 'Resume' : 'Pause'}
            className="grid size-16 place-items-center rounded-full bg-white text-black shadow-xl transition hover:scale-105 active:scale-95">
            {radio.paused ? <Play className="ml-0.5 size-7 fill-current" /> : <Pause className="size-7 fill-current" />}
          </button>
          <button onClick={() => radio.skip()} disabled={radio.skipping} aria-label="Skip"
            className="grid size-10 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40">
            {radio.skipping ? <Spinner className="text-current" /> : <SkipForward className="size-5" />}
          </button>
        </div>

        {/* Volume + secondary controls */}
        <div className="mt-4 flex items-center gap-3">
          <button onClick={radio.toggleMute} aria-label={radio.muted ? 'Unmute' : 'Mute'} className="shrink-0 text-white/70 hover:text-white">
            {radio.muted || radio.volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
          </button>
          <input
            type="range" min={0} max={1} step={0.01}
            value={radio.muted ? 0 : radio.volume}
            onChange={e => radio.setVolume(Number(e.target.value))}
            aria-label="Volume"
            className="h-1 flex-1 cursor-pointer accent-white"
          />
          <button onClick={radio.toggleVisualizer} aria-label="Toggle visualizer" title={radio.visualizerEnabled ? 'Visualizer on' : 'Visualizer off'}
            className={cn('shrink-0 hover:text-white', radio.visualizerEnabled ? 'text-white/80' : 'text-white/35')}>
            <AudioLines className="size-4" />
          </button>
          <button onClick={() => navigate(radio.station?.stationId ? `/music/watch/${radio.station.stationId}` : '/music/watch/current')}
            aria-label="Watch video" title="Switch to video" className="shrink-0 text-white/70 hover:text-white">
            <MonitorPlay className="size-4" />
          </button>
          <button onClick={download} aria-label="Save offline" className="shrink-0 text-white/70 hover:text-white">
            <Download className="size-4" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button aria-label="DJ mode" title={`DJ: ${radio.station?.djMode ?? 'full'}`}
                className={cn('shrink-0 hover:text-white', (radio.station?.djMode ?? 'full') === 'silent' ? 'text-white/35' : 'text-white/70')}>
                <Mic className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {([['full', 'Full DJ'], ['minimal', 'DJ minimal'], ['silent', 'Silent (no DJ)']] as const).map(([mode, label]) => (
                <DropdownMenuItem key={mode} onClick={() => radio.setDjMode(mode)}>
                  {(radio.station?.djMode ?? 'full') === mode ? '✓ ' : ''}{label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Tabs: Lyrics / Up Next / About, themed on a dark card so tokens stay readable */}
        <div data-theme="dark" className="mt-5 flex min-h-0 flex-1 flex-col text-foreground">
          <div className="flex shrink-0 gap-1 rounded-full bg-white/10 p-1 text-sm">
            {([['lyrics', 'Lyrics'], ['up-next', 'Up Next'], ['about', 'About']] as [Tab, string][]).map(([id, lbl]) => (
              <button key={id} onClick={() => setTab(id)}
                className={cn('flex-1 rounded-full px-3 py-1.5 font-medium transition-colors',
                  tab === id ? 'bg-white text-black' : 'text-white/70 hover:text-white')}>
                {lbl}
              </button>
            ))}
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-4">
            {tab === 'lyrics' && (
              cur ? <LyricsPanel artist={artist} title={cur.title} />
                  : <div className="flex h-full items-center justify-center text-white/60"><Music2 className="mr-2 size-5 opacity-40" /> Tuning in…</div>
            )}

            {tab === 'about' && (
              <div className="space-y-3">
                {cur ? <AboutStrip artist={artist} title={cur.title} color={c1} /> : null}
                {cur ? <SmartLinksRow artist={artist} title={cur.title} color={c1} /> : null}
              </div>
            )}

            {tab === 'up-next' && (
              <div className="space-y-1">
                <SectionLabel icon={ListMusic} color={c1}>Up Next</SectionLabel>
                {upNext.length === 0 && !radio.queueLoading && (
                  <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-white/60">
                    <ListMusic className="size-7 opacity-30" />
                    <p className="text-sm">Nothing queued.</p>
                  </div>
                )}
                {upNext.map((t, i) => (
                  <div key={t.videoId + i} className="flex items-center gap-3 rounded-control px-2 py-1.5">
                    <span className="w-4 shrink-0 text-center text-xs tabular-nums text-white/40">{i + 1}</span>
                    <SongArt trackRef={t.videoId} title={t.title} artist={t.author} className="size-10" rounded="rounded-control" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-white">{t.title}</p>
                      {t.author && <p className="truncate text-xs text-white/60">{t.author}</p>}
                    </div>
                  </div>
                ))}
                {radio.queueLoading && (
                  <div className="space-y-2 pt-1">
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={`ph-${i}`} className="flex items-center gap-3 px-2 py-1.5">
                        <Skeleton className="size-10 shrink-0 rounded-control" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <Skeleton className="h-3.5 w-3/4" />
                          <Skeleton className="h-3 w-2/5" />
                        </div>
                      </div>
                    ))}
                    <p className="flex items-center justify-center gap-2 py-1 text-xs text-white/60">
                      <Spinner size="sm" /> Building the rest of the station…
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
