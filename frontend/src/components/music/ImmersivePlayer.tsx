import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Play, Pause, SkipForward, SkipBack, ImageIcon, Sparkles, ChevronDown } from 'lucide-react'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import { useRadio } from '@/context/RadioContext'
import { useTitleMask } from '@/lib/music/policy'
import { proxyImgAuto } from '@/lib/img'
import { useAlbumPalette, accentOf, readableOn } from '@/lib/music/albumColors'
import { useWaveform } from '@/lib/music/metaApi'
import { UltraBlur } from '@/components/music/UltraBlur'
import { WaveformSeekBar } from '@/components/music/WaveformSeekBar'
import { AudioVisualizer, VISUALIZERS, useVisualizerPref, setVisualizerPref } from '@/components/shared/AudioVisualizer'
import { usePlayerOverlay } from '@/context/PlayerOverlayContext'
import { useSongArt } from '@/components/music/SongArt'
import { LyricsPanel } from '@/components/music/nowPlayingParts'

/** App-level mount: renders the immersive player when the overlay context has it open. */
export function ImmersivePlayerMount() {
  const { immersive, closeImmersive } = usePlayerOverlay()
  return <ImmersivePlayer open={immersive} onClose={closeImmersive} />
}

const MODE_KEY = 'music.immersiveShowVisualizer'
const LYR_KEY = 'music.immersiveShowLyrics'

/** Plexamp-style fullscreen Now Playing: an "UltraBlur" album-colour backdrop, big art that
 *  swaps to a live audio-reactive visualizer (tap the art, Plexamp-style), the seekprint
 *  soundwave seek bar, prominent Up Next, and lean accent-tinted controls. Enters the
 *  browser Fullscreen API on open so it fills the TV / display. */
export function ImmersivePlayer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const radio = useRadio()
  const mask = useTitleMask()
  const rootRef = useRef<HTMLDivElement>(null)
  const [showVis, setShowVis] = useState(() => localStorage.getItem(MODE_KEY) === '1')
  const [showLyr, setShowLyr] = useState(() => localStorage.getItem(LYR_KEY) === '1')
  // ONE app-wide scene choice, shared with the mini/ambient strips.
  const variant = useVisualizerPref()
  const [idle, setIdle] = useState(false)

  const track = radio.currentTrack
  // Real square album art when it resolves; the 16:9 video thumbnail (letterboxed) only
  // as the instant fallback - same contract as the overlay and now-playing page.
  const squareArt = useSongArt(track?.videoId, track?.title, track?.author)
  const artUrl = squareArt ?? (track?.thumbnail ? proxyImgAuto(track.thumbnail) : '')
  const palette = useAlbumPalette(artUrl || null)
  const accent = accentOf(palette)

  // The track's server loudness envelope feeds the Soundprint visualizer.
  const peaks = useWaveform(open ? track?.videoId : null)

  // The queue tail after the current index, for the Up Next strip.
  const upNext = radio.queue.slice(radio.index + 1, radio.index + 5)

  useEffect(() => { localStorage.setItem(MODE_KEY, showVis ? '1' : '0') }, [showVis])
  useEffect(() => { localStorage.setItem(LYR_KEY, showLyr ? '1' : '0') }, [showLyr])

  // Esc closes the immersive layer (the browser Fullscreen API is driven by the context that
  // opens it, so here we only need the keyboard affordance for the non-fullscreen fallback).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Auto-hide the chrome after a few seconds of no pointer movement (kiosk/TV feel).
  // Desktop/TV only: on a phone there's no hovering pointer, so chrome vanishing and
  // reappearing on stray touches reads as the UI randomly hiding itself.
  useEffect(() => {
    if (!open) return
    if (window.matchMedia('(max-width: 767px)').matches) { setIdle(false); return }
    let t: ReturnType<typeof setTimeout>
    const bump = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 3500) }
    bump()
    window.addEventListener('pointermove', bump)
    window.addEventListener('keydown', bump)
    return () => { clearTimeout(t); window.removeEventListener('pointermove', bump); window.removeEventListener('keydown', bump) }
  }, [open])

  if (!open) return null

  const progress = radio.durationSec > 0 ? radio.positionSec / radio.durationSec : 0
  const canSeek = radio.phase === 'playing' && !radio.djSpeaking && radio.durationSec > 0

  return createPortal(
    <div ref={rootRef}
      // max-md: stops above the bottom chrome so the tab bar stays visible (Mobile
      // Design Contract); desktop keeps the true lean-back fullscreen.
      className={cn('fixed inset-0 max-md:bottom-[var(--bottom-chrome,0px)] z-[200] overflow-hidden bg-black text-white select-none', idle && 'cursor-none')}>

      {/* UltraBlur backdrop: four extracted corner colours over the massively blurred cover. */}
      <UltraBlur artUrl={artUrl || null} palette={palette} scrim="light" />

      {/* Center stage: album art, lyrics, or the visualizer - picked from the ONE stage
          dropdown (tap-to-toggle was removed: it fought the dropdown and read as random). */}
      <div className="absolute inset-0 flex items-center justify-center">
        {showLyr ? null : showVis ? (
          <AudioVisualizer variant={variant} mode="full" getAnalyser={radio.getAnalyser} palette={palette}
            active={!radio.paused} peaks={peaks} progress={progress} className="absolute inset-0" />
        ) : (
          artUrl
            ? <img src={artUrl} alt="" className="aspect-square w-[min(46vh,46vw)] rounded-[18px] object-cover shadow-2xl"
                style={{ boxShadow: `0 30px 120px -20px ${palette.vibrant}` }} />
            : <div className="grid aspect-square w-[min(46vh,46vw)] place-items-center rounded-[18px] bg-white/5"><ImageIcon className="size-16 text-white/30" /></div>
        )}
      </div>

      {/* Lyrics stage (LYR): synced lyrics over the bare UltraBlur, Plexamp-style. The panel
          uses theme tokens, so pin the dark theme regardless of the app's. */}
      {showLyr && track && (
        <div data-theme="dark" className="absolute inset-x-0 bottom-52 top-16 mx-auto w-full max-w-3xl px-6 text-foreground">
          <LyricsPanel artist={track.author ?? ''} title={track.title}
            position={radio.positionSec} duration={radio.durationSec || undefined} onSeek={radio.seek} />
        </div>
      )}

      {/* Floating chrome: ONE stage selector (album art / lyrics / each scene) + close.
          The old row of station label + VIZ + LYR + style pills read as clutter. */}
      <div className={cn('absolute right-5 top-5 z-10 flex items-center gap-2 transition-opacity duration-500', idle && 'opacity-0')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button"
              className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium backdrop-blur transition hover:bg-white/20"
              title="Change what's on stage">
              <Sparkles className="size-3.5" />
              {showLyr ? 'Lyrics' : showVis ? VISUALIZERS.find(v => v.id === variant)?.label : 'Album art'}
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          {/* z-[210]: this layer is z-[200]; the default menu z-50 would land behind it */}
          <DropdownMenuContent align="end" className="z-[210]">
            <DropdownMenuItem onClick={() => { setShowVis(false); setShowLyr(false) }}>
              {!showVis && !showLyr ? '✓ ' : ''}Album art
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setShowLyr(true)}>
              {showLyr ? '✓ ' : ''}Lyrics
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {VISUALIZERS.map(v => (
              <DropdownMenuItem key={v.id} onClick={() => { setVisualizerPref(v.id); setShowVis(true); setShowLyr(false) }}>
                {showVis && !showLyr && v.id === variant ? '✓ ' : ''}{v.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button type="button" onClick={onClose}
          className="grid size-9 place-items-center rounded-full bg-white/10 backdrop-blur transition hover:bg-white/20" title="Close">
          <X className="size-5" />
        </button>
      </div>

      {/* Bottom: title + soundwave seek + controls + Up Next */}
      <div className={cn('absolute inset-x-0 bottom-0 flex flex-col gap-4 p-6 pb-8 transition-opacity duration-500',
        'bg-gradient-to-t from-black/70 to-transparent', idle && 'opacity-0')}>
        <div className="flex items-end justify-between gap-6">
          <div className="min-w-0">
            <div className="truncate text-3xl font-bold tracking-tight md:text-5xl">{track ? mask(track.title) : 'Nothing playing'}</div>
            {track?.author && <div className="mt-1 truncate text-lg text-white/70 md:text-2xl">{track.author}</div>}
          </div>

          {/* Up Next */}
          {upNext.length > 0 && (
            <div className="hidden max-w-xs shrink-0 md:block">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-white/40">Up Next</div>
              <div className="flex flex-col gap-1.5">
                {upNext.map((t, i) => (
                  <div key={`${t.videoId}-${i}`} className="flex items-center gap-2 text-sm">
                    {t.thumbnail
                      ? <img src={proxyImgAuto(t.thumbnail)} alt="" className="size-8 rounded object-cover" />
                      : <div className="size-8 rounded bg-white/10" />}
                    <div className="min-w-0">
                      <div className="truncate font-medium text-white/90">{mask(t.title)}</div>
                      {t.author && <div className="truncate text-xs text-white/50">{t.author}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Seekprint: the real loudness envelope, played portion in the album accent. */}
        {track && (
          <WaveformSeekBar trackRef={track.videoId} pos={radio.positionSec} total={radio.durationSec}
            onSeek={radio.seek} accent={accent} disabled={!canSeek} clocks className="mx-auto w-full max-w-3xl" />
        )}

        {/* Controls */}
        <div className="flex items-center justify-center gap-6">
          <button type="button" onClick={() => radio.seek(0)} disabled={!canSeek}
            className="text-white/60 transition hover:text-white disabled:opacity-40" title="Restart track"><SkipBack className="size-6" /></button>
          <button type="button" onClick={radio.togglePause}
            className="grid size-16 place-items-center rounded-full shadow-xl transition hover:scale-105"
            style={{ background: accent, color: readableOn(accent) }}
            title={radio.paused ? 'Play' : 'Pause'}>
            {radio.paused ? <Play className="size-7 translate-x-0.5 fill-current" /> : <Pause className="size-7 fill-current" />}
          </button>
          <button type="button" onClick={radio.skip} className="text-white/60 transition hover:text-white" title="Next"><SkipForward className="size-6" /></button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
