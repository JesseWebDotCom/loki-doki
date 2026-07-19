import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  ChevronDown, Heart, Download, MonitorPlay, Play, Pause, SkipForward, AudioLines,
  Mic, Mic2, Moon, Volume2, VolumeX, ListMusic, Disc3, Sparkles, RotateCcw, RotateCw, Repeat1,
  SlidersHorizontal, MoreHorizontal, Radio, Shuffle, Bookmark,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { useRadio } from '@/context/RadioContext'
import { usePlayerOverlay } from '@/context/PlayerOverlayContext'
import { useCatalogNav } from '@/lib/music/catalogNav'
import { AudioVisualizer, VISUALIZERS, useVisualizerPref, setVisualizerPref } from '@/components/shared/AudioVisualizer'
import { StarRating } from '@/components/music/StarRating'
import { useTitleMask } from '@/lib/music/policy'
import { useSongArt } from '@/components/music/SongArt'
import { useArtPalette, accentOf, readableOn } from '@/lib/artPalette'
import { UltraBlur } from '@/components/shared/UltraBlur'
import { AppTabBar } from '@/components/shared/AppTabBar'
import { TrackTechBadge } from '@/components/music/TrackTechBadge'
import { WaveformSeekBar } from '@/components/music/WaveformSeekBar'
import { CastButton } from '@/components/music/CastButton'
import { Spinner } from '@/components/ui/spinner'
import { Skeleton } from '@/components/ui/skeleton'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from '@/components/ui/dropdown-menu'
import { LyricsPanel, AboutStrip, SmartLinksRow, SectionLabel, UpNextList, TuningLyrics, useSourceBackLink, useNowPlayingPrefetch } from './nowPlayingParts'
import { EqPanel } from './EqPanel'
import { saveOffline, listTrackMoments, addTrackMoment, removeTrackMoment } from '@/lib/music/catalogApi'
import { useFavorite } from '@/lib/music/useFavorite'
import { MomentsPanel } from '@/components/shared/MomentsPanel'
import { AskTrackPanel } from '@/components/music/AskTrackPanel'
import { startTrackRadio } from '@/components/music/TrackRadioButton'
import { isYouTubeRef } from '@/lib/music/trackRef'
import { useWaveform } from '@/lib/music/metaApi'
import { queueForKaraoke } from '@/lib/music/karaokeQueue'

type Tab = 'lyrics' | 'ask' | 'moments' | 'up-next' | 'about'

// The app-wide, immersive "full page" player (Apple Music / Plexamp style). It reuses the
// existing playback engine wholesale via useRadio() (no engine changes). Raised from the
// mini-player bar (or the rail / a deep link) and dismissed by dragging down or the chevron;
// the audio keeps playing underneath either way.
export function NowPlayingOverlay() {
  const { open, closePlayer, openImmersive } = usePlayerOverlay()
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
  // Unconditional hooks (before the early return): real square album art for cover + backdrop,
  // and its extracted palette for the UltraBlur wash. Prefetch keeps the next track's
  // art/lyrics/info warm even while the overlay is closed (staleTime:Infinity cache warming,
  // inherited from the retired NowPlayingPage).
  const overlayArt = useSongArt(curForArt?.videoId, curForArt?.title, curForArt?.author, null)
  const palette = useArtPalette(overlayArt ?? (curForArt?.thumbnail ? proxyImg(curForArt.thumbnail) : null))
  const mask = useTitleMask()
  const sourceBackLink = useSourceBackLink()
  useNowPlayingPrefetch()
  const [eqOpen, setEqOpen] = useState(false)
  const stripVariant = useVisualizerPref()
  // Loudness envelope for the strip Soundprint at the bottom of the overlay.
  const stripPeaks = useWaveform(curForArt?.videoId)
  const { isFavorite, toggle: toggleFavorite } = useFavorite('song', curForArt?.videoId)

  if (!open) return null

  const cur = curForArt
  const accent = accentOf(palette)
  // design-ok(hex-in-tsx): station accent fallbacks (brand hues) - canvas/gradient literals
  const c1 = radio.station?.color ?? '#fb923c'
  const c2 = radio.station?.colorDark ?? '#f97316'
  const emoji = radio.station?.emoji ?? '📻'
  const artist = cur?.author ?? ''
  const canSeek = radio.phase === 'playing' && !radio.djSpeaking && radio.durationSec > 0
  const upNext = radio.queue.slice(radio.index + 1, radio.index + 25)

  const favorite = () => { if (cur) void toggleFavorite({ title: cur.title, artist }) }
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
      // max-md: stops above the bottom chrome so the tab bar stays visible (Mobile
      // Design Contract); desktop keeps the true full-viewport fullscreen player.
      // design-ok(raw-overlay): see the block comment above (full-screen player surface)
      className="fixed inset-0 max-md:bottom-[var(--bottom-chrome,0px)] z-[100] flex flex-col text-white"
      style={{ transform: dragY ? `translateY(${dragY}px)` : undefined, transition: dragY ? 'none' : 'transform 0.25s ease' }}
    >
      {/* Backdrop: UltraBlur - four corner colours extracted from the cover give each song
          its own persona (Plexamp's "smoked glass" look), scrimmed for readable chrome. */}
      <UltraBlur artUrl={overlayArt ?? (cur?.thumbnail ? proxyImg(cur.thumbnail) : null)}
        palette={palette} className="-z-10" />

      {/* Ambient visualizer strip across the very bottom (shared strip style) */}
      {radio.visualizerEnabled && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40">
          <AudioVisualizer variant={stripVariant} mode="strip" active={!radio.paused}
            getAnalyser={radio.getAnalyser} palette={palette}
            peaks={stripPeaks} progress={radio.durationSec > 0 ? radio.positionSec / radio.durationSec : 0}
            opacity={0.35} fade />
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
          <span className="flex min-w-0 items-center gap-2">
            <span className="inline-flex items-center gap-1.5 truncate rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-white/90">
              <span>{emoji}</span> {radio.station?.label ?? 'AI Radio'}
            </span>
            {sourceBackLink && (
              <button onClick={() => { closePlayer(); navigate(sourceBackLink.url) }}
                className="inline-flex items-center gap-1 truncate rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/70 transition hover:bg-white/20 hover:text-white">
                ← {sourceBackLink.label}
              </button>
            )}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button aria-label="Sleep timer" className="grid size-9 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white">
                <Moon className={cn('size-5', radio.sleepAtMs && 'text-white')} />
              </button>
            </DropdownMenuTrigger>
            {/* z-[110]: menus portal at z-50 by default, which lands BEHIND this z-[100] player */}
            <DropdownMenuContent align="end" className="z-[110]">
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
            title="View album details">{mask(cur?.title ?? 'AI Radio')}</button>
          {artist && (
            <button onClick={() => cat.openArtist(artist)} disabled={cat.pending === 'artist'}
              className="mt-1 block w-full truncate text-sm text-white/70 transition hover:text-white hover:underline disabled:opacity-60"
              title="View artist details">{artist}</button>
          )}
          {/* Plexamp's "FLAC ★★★★★ 44/16" row: format badge + stars together under the title. */}
          {cur && (
            <div className="mt-2 flex items-center justify-center gap-3">
              <StarRating trackRef={cur.videoId} title={cur.title} artist={artist} size="sm" />
              <TrackTechBadge trackRef={cur.videoId} />
            </div>
          )}
        </div>

        {/* Seekprint: real loudness envelope, elapsed left / -remaining right, played
            portion in the album accent - no thumb, the colour boundary is the playhead. */}
        {cur && (
          <WaveformSeekBar trackRef={cur.videoId} pos={radio.positionSec} total={radio.durationSec}
            onSeek={radio.seek} accent={accent} disabled={!canSeek} clocks className="mt-3" />
        )}

        {/* Transport */}
        <div className="mt-3 flex items-center justify-center gap-4">
          <button onClick={favorite} aria-label={isFavorite ? 'Remove from favorites' : 'Favorite'}
            className={cn('grid size-10 place-items-center rounded-full hover:bg-white/10 hover:text-white', isFavorite ? 'text-white' : 'text-white/80')}>
            <Heart className={cn('size-5', isFavorite && 'fill-current')} />
          </button>
          <button onClick={() => radio.setRepeatOne(!radio.repeatOne)} aria-label="Repeat one"
            title={radio.repeatOne ? 'Repeat on' : 'Repeat off'}
            className={cn('grid size-10 place-items-center rounded-full hover:bg-white/10', radio.repeatOne ? 'text-white' : 'text-white/50')}>
            <Repeat1 className="size-5" />
          </button>
          <button onClick={() => radio.seekBy(-15)} disabled={!canSeek} aria-label="Back 15 seconds" title="Back 15s"
            className="relative grid size-10 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40">
            <RotateCcw className="size-6" /><span className="absolute text-[9px] font-bold">15</span>
          </button>
          <button onClick={() => radio.togglePause()} aria-label={radio.paused ? 'Resume' : 'Pause'}
            className="grid size-16 place-items-center rounded-full shadow-xl transition hover:scale-105 active:scale-95"
            style={{ background: accent, color: readableOn(accent) }}>
            {radio.paused ? <Play className="ml-0.5 size-7 fill-current" /> : <Pause className="size-7 fill-current" />}
          </button>
          <button onClick={() => radio.seekBy(30)} disabled={!canSeek} aria-label="Forward 30 seconds" title="Skip ahead 30s (e.g. past an ad)"
            className="relative grid size-10 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40">
            <RotateCw className="size-6" /><span className="absolute text-[9px] font-bold">30</span>
          </button>
          <button onClick={() => radio.skip()} disabled={radio.skipping} aria-label="Skip"
            className="grid size-10 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white disabled:opacity-40">
            {radio.skipping ? <Spinner className="text-current" /> : <SkipForward className="size-5" />}
          </button>
        </div>

        {/* Volume + a calm secondary row: immersive stays inline (the marquee lean-back
            action); everything else lives behind one labeled overflow menu. Seven bare
            icons here read as clutter on a phone. */}
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
          <span className="shrink-0 text-white/70">
            <CastButton
              trackRef={radio.currentTrack?.videoId ?? null}
              title={radio.currentTrack?.title ?? 'Loki Doki'}
              artist={radio.currentTrack?.author ?? null}
              onCastStart={() => { if (!radio.paused) radio.togglePause() }}
            />
          </span>
          <button onClick={openImmersive} aria-label="Fullscreen visualizer" title="Fullscreen visualizer"
            className="grid size-9 shrink-0 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white">
            <Sparkles className="size-4" />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button aria-label="More options"
                className="grid size-9 shrink-0 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white">
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            {/* z-[110]: menus portal at z-50 by default, which lands BEHIND this z-[100] player */}
            <DropdownMenuContent align="end" className="z-[110] w-52">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <AudioLines className="mr-2 size-4" />
                  Visualizer: {radio.visualizerEnabled ? VISUALIZERS.find(v => v.id === stripVariant)?.label : 'None'}
                </DropdownMenuSubTrigger>
                {/* ONE app-wide scene choice (None or a scene), shared by the ambient strips
                    (this overlay's bottom band, mini players, Studio, audio-only video) AND
                    the fullscreen visualizer. Center-anchored scenes can't draw in a short
                    strip, so strips fall back to Spectrum for those. */}
                <DropdownMenuSubContent className="z-[110]">
                  <DropdownMenuItem onClick={() => { if (radio.visualizerEnabled) radio.toggleVisualizer() }}>
                    {!radio.visualizerEnabled ? '✓ ' : ''}None
                  </DropdownMenuItem>
                  {VISUALIZERS.map(v => (
                    <DropdownMenuItem key={v.id} onClick={() => { setVisualizerPref(v.id); if (!radio.visualizerEnabled) radio.toggleVisualizer() }}>
                      {radio.visualizerEnabled && v.id === stripVariant ? '✓ ' : ''}{v.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onClick={() => setEqOpen(true)}>
                <SlidersHorizontal className="size-4" />
                Equalizer & sound
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate(radio.station?.stationId ? `/music/watch/${radio.station.stationId}` : '/music/watch/current')}>
                <MonitorPlay className="size-4" />
                Switch to video
              </DropdownMenuItem>
              {cur && isYouTubeRef(cur.videoId) && (
                <DropdownMenuItem onClick={() => { queueForKaraoke({ videoId: cur.videoId, title: cur.title, artist, durationSec: radio.durationSec || null }); closePlayer(); navigate('/music/karaoke') }}>
                  <Mic2 className="size-4" />
                  Karaoke this song
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={download}>
                <Download className="size-4" />
                Save offline
              </DropdownMenuItem>
              {cur && (
                <DropdownMenuItem onClick={() => { void startTrackRadio(radio, { videoId: cur.videoId, title: cur.title, artist }) }}>
                  <Radio className="size-4" />
                  Start Track Radio
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Shuffle className="mr-2 size-4" />
                  Shuffle: {radio.shuffleMode === 'off' ? 'Off' : radio.shuffleMode === 'random' ? 'True random' : 'No repeats'}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="z-[110] w-64">
                  {([
                    ['off', 'Off', 'Play the queue in order'],
                    ['random', 'True random', 'Picks the next song at random every time'],
                    ['bag', 'No repeats', 'Shuffles through everything once before anything plays again'],
                  ] as const).map(([mode, label, hint]) => (
                    <DropdownMenuItem key={mode} onClick={() => radio.setShuffleMode(mode)}>
                      <span className="min-w-0">
                        <span className="block">{radio.shuffleMode === mode ? '✓ ' : ''}{label}</span>
                        <span className="block text-xs text-muted-foreground">{hint}</span>
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Mic className="mr-2 size-4" />
                  DJ: {(radio.station?.djMode ?? 'full') === 'full' ? 'Full' : (radio.station?.djMode ?? 'full') === 'minimal' ? 'Minimal' : 'Silent'}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="z-[110]">
                  {([['full', 'Full DJ'], ['minimal', 'DJ minimal'], ['silent', 'Silent (no DJ)']] as const).map(([mode, label]) => (
                    <DropdownMenuItem key={mode} onClick={() => radio.setDjMode(mode)}>
                      {(radio.station?.djMode ?? 'full') === mode ? '✓ ' : ''}{label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Tabs: Lyrics / Up Next / About, themed on a dark card so tokens stay readable */}
        <div data-theme="dark" className="mt-5 flex min-h-0 flex-1 flex-col text-foreground">
          <AppTabBar
            tabs={[
              { id: 'lyrics', label: 'Lyrics' },
              { id: 'ask', label: 'Ask', icon: Sparkles },
              { id: 'moments', label: 'Moments', icon: Bookmark },
              { id: 'up-next', label: 'Up Next' },
              { id: 'about', label: 'About' },
            ]}
            value={tab} onChange={setTab} variant="glass" compact className="shrink-0"
          />

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-4">
            {tab === 'lyrics' && (
              // While the station spins up (no track cued yet, or the DJ intro is still being
              // written), show the station's playful tuning lines instead of empty lyrics.
              cur && !(radio.phase === 'intro' && !radio.djSpeaking)
                ? <LyricsPanel artist={artist} title={cur.title} position={radio.positionSec} duration={radio.durationSec} />
                : <TuningLyrics stationId={radio.station?.stationId} color={c1} />
            )}

            {tab === 'ask' && (
              cur ? <AskTrackPanel artist={artist} title={cur.title} /> : null
            )}

            {tab === 'moments' && (
              cur ? (
                <MomentsPanel
                  queryKey={['music-moments', cur.videoId]}
                  currentSec={radio.positionSec} onSeek={radio.seek}
                  listMoments={() => listTrackMoments(cur.videoId)}
                  addMoment={(atSec, opts) => addTrackMoment(cur.videoId, atSec, opts)}
                  removeMoment={removeTrackMoment}
                  emptyHint="Save a moment for your family: a reaction, or a note about the bit worth catching again. It stays on your home server."
                />
              ) : null
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
                <UpNextList tracks={upNext} baseIndex={radio.index + 1} />
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

      <EqPanel open={eqOpen} onOpenChange={setEqOpen} />
    </div>,
    document.body,
  )
}
