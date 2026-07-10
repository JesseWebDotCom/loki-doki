import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Play, Pause, SkipForward, SkipBack, ImageIcon, Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useRadio } from '@/context/RadioContext'
import { useTitleMask } from '@/lib/music/policy'
import { proxyImgAuto } from '@/lib/img'
import { useAlbumPalette, accentOf, readableOn } from '@/lib/music/albumColors'
import { getWaveform } from '@/lib/music/metaApi'
import { UltraBlur } from '@/components/music/UltraBlur'
import { WaveformSeekBar } from '@/components/music/WaveformSeekBar'
import { MusicVisualizer, VISUALIZERS, type VisualizerVariant } from '@/components/music/MusicVisualizer'
import { usePlayerOverlay } from '@/context/PlayerOverlayContext'
import { useSongArt } from '@/components/music/SongArt'

/** App-level mount: renders the immersive player when the overlay context has it open. */
export function ImmersivePlayerMount() {
  const { immersive, closeImmersive } = usePlayerOverlay()
  return <ImmersivePlayer open={immersive} onClose={closeImmersive} />
}

const VIS_KEY = 'music.immersiveVisualizer'
const MODE_KEY = 'music.immersiveShowVisualizer'

/** Plexamp-style fullscreen Now Playing: an "UltraBlur" album-colour backdrop, big art that
 *  swaps to a live audio-reactive visualizer (tap the art, Plexamp-style), the seekprint
 *  soundwave seek bar, prominent Up Next, and lean accent-tinted controls. Enters the
 *  browser Fullscreen API on open so it fills the TV / display. */
export function ImmersivePlayer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const radio = useRadio()
  const mask = useTitleMask()
  const rootRef = useRef<HTMLDivElement>(null)
  const [showVis, setShowVis] = useState(() => localStorage.getItem(MODE_KEY) === '1')
  const [variant, setVariant] = useState<VisualizerVariant>(() =>
    (VISUALIZERS.find(v => v.id === localStorage.getItem(VIS_KEY))?.id) ?? 'fan')
  const [idle, setIdle] = useState(false)

  const track = radio.currentTrack
  // Real square album art when it resolves; the 16:9 video thumbnail (letterboxed) only
  // as the instant fallback - same contract as the overlay and now-playing page.
  const squareArt = useSongArt(track?.videoId, track?.title, track?.author)
  const artUrl = squareArt ?? (track?.thumbnail ? proxyImgAuto(track.thumbnail) : '')
  const palette = useAlbumPalette(artUrl || null)
  const accent = accentOf(palette)

  // The track's server loudness envelope feeds the Soundprint visualizer (and would be
  // cheap to reuse elsewhere - getWaveform misses lazily queue a scan server-side).
  const [peaks, setPeaks] = useState<number[] | null>(null)
  useEffect(() => {
    if (!open || !track?.videoId) { setPeaks(null); return }
    let alive = true
    setPeaks(null)
    getWaveform(track.videoId).then(p => { if (alive) setPeaks(p) })
    return () => { alive = false }
  }, [open, track?.videoId])

  // The queue tail after the current index, for the Up Next strip.
  const upNext = radio.queue.slice(radio.index + 1, radio.index + 5)

  useEffect(() => { localStorage.setItem(MODE_KEY, showVis ? '1' : '0') }, [showVis])
  useEffect(() => { localStorage.setItem(VIS_KEY, variant) }, [variant])

  // Esc closes the immersive layer (the browser Fullscreen API is driven by the context that
  // opens it, so here we only need the keyboard affordance for the non-fullscreen fallback).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Auto-hide the chrome after a few seconds of no pointer movement (kiosk/TV feel).
  useEffect(() => {
    if (!open) return
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
  const cycleVisualizer = () => {
    const i = VISUALIZERS.findIndex(v => v.id === variant)
    setVariant(VISUALIZERS[(i + 1) % VISUALIZERS.length]!.id)
  }

  return createPortal(
    <div ref={rootRef}
      className={cn('fixed inset-0 z-[200] overflow-hidden bg-black text-white select-none', idle && 'cursor-none')}>

      {/* UltraBlur backdrop: four extracted corner colours over the massively blurred cover. */}
      <UltraBlur artUrl={artUrl || null} palette={palette} scrim="light" />

      {/* Center stage: album art OR the visualizer. Tap to toggle between them (Plexamp). */}
      <button type="button" onClick={() => setShowVis(v => !v)}
        className="absolute inset-0 flex items-center justify-center"
        title={showVis ? 'Show album art' : 'Show visualizer'}>
        {showVis ? (
          <MusicVisualizer variant={variant} getAnalyser={radio.getAnalyser} palette={palette}
            active={!radio.paused} peaks={peaks} progress={progress} className="absolute inset-0" />
        ) : (
          artUrl
            ? <img src={artUrl} alt="" className="aspect-square w-[min(46vh,46vw)] rounded-[18px] object-cover shadow-2xl"
                style={{ boxShadow: `0 30px 120px -20px ${palette.vibrant}` }} />
            : <div className="grid aspect-square w-[min(46vh,46vw)] place-items-center rounded-[18px] bg-white/5"><ImageIcon className="size-16 text-white/30" /></div>
        )}
      </button>

      {/* Top bar */}
      <div className={cn('absolute inset-x-0 top-0 flex items-center justify-between p-5 transition-opacity duration-500', idle && 'opacity-0')}>
        <div className="min-w-0">
          {radio.station?.label && <div className="text-xs font-medium uppercase tracking-[0.2em] text-white/50">{radio.station.label}</div>}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={(e) => { e.stopPropagation(); setShowVis(v => !v) }}
            className={cn('rounded-full px-3 py-1.5 text-[11px] font-bold tracking-widest backdrop-blur transition',
              showVis ? 'bg-white/90 text-black' : 'bg-white/10 text-white/80 hover:bg-white/20')}
            title={showVis ? 'Show album art' : 'Show visualizer'}>
            VIZ
          </button>
          {showVis && (
            <button type="button" onClick={(e) => { e.stopPropagation(); cycleVisualizer() }}
              className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium backdrop-blur transition hover:bg-white/20"
              title="Change visualizer">
              <Sparkles className="size-3.5" /> {VISUALIZERS.find(v => v.id === variant)?.label}
            </button>
          )}
          <button type="button" onClick={onClose}
            className="grid size-9 place-items-center rounded-full bg-white/10 backdrop-blur transition hover:bg-white/20" title="Exit fullscreen">
            <X className="size-5" />
          </button>
        </div>
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
