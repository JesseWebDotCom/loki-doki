import { AudioLines, Music, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useRadio } from '@/context/RadioContext'
import { VISUALIZERS, setVisualizerPref, useVisualizerPref } from '@/components/shared/AudioVisualizer'
import { useArtPalette, accentOf } from '@/lib/artPalette'
import { SpectroBars } from './SpectroBars'
import type { NowPlayingInfo } from './useNowPlaying'

// Now-playing renderers for the island, styled after TheBoringNotch's media
// player: large rounded album art, stacked bold title / dim artist, a thin
// seek bar with elapsed and total times, and a clean centered transport row.
//   chip: wing content in the compact bar (art + spectrogram)
//   row:  peek surface summary
//   card: full-panel player
// Tier 2 (media playing in another window/device) has no controls; clicking
// deep-links into the main app window.

function openDeepLink(info: NowPlayingInfo) {
  window.lokiDesktop?.openMainWindow(info.deepLink)
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

function Art({ info, px, radius = 'rounded-control' }: { info: NowPlayingInfo; px: number; radius?: string }) {
  if (!info.artUrl) {
    return (
      // design-ok(glass-on-plain-bg): placeholder art tile inside the black island surface
      <span className={cn('flex items-center justify-center bg-white/10', radius)} style={{ width: px, height: px }}>
        <Music className="size-1/2 text-white/60" />
      </span>
    )
  }
  return (
    <img
      src={info.artUrl}
      alt=""
      className={cn('object-cover shadow-lg', radius)}
      style={{ width: px, height: px }}
      draggable={false}
    />
  )
}

// Visualizer picker (ported from NowPlayingOverlay): choose the ambient strip
// style or turn it off. Only meaningful for tier-1 radio, whose Web Audio
// analyser lives in this window.
function VisualizerPicker() {
  const radio = useRadio()
  const pref = useVisualizerPref()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Visualizer"
          title="Visualizer"
          // design-ok(glass-on-plain-bg): sits inside the black island surface
          className={cn('size-7 rounded-full hover:bg-white/10', radio.visualizerEnabled ? 'text-white' : 'text-white/45 hover:text-white')}
        >
          <AudioLines className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem onClick={() => { if (radio.visualizerEnabled) radio.toggleVisualizer() }}>
          {!radio.visualizerEnabled ? '✓ ' : ''}None
        </DropdownMenuItem>
        {VISUALIZERS.map((v) => (
          <DropdownMenuItem key={v.id} onClick={() => { setVisualizerPref(v.id); if (!radio.visualizerEnabled) radio.toggleVisualizer() }}>
            {radio.visualizerEnabled && pref === v.id ? '✓ ' : ''}{v.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Thin seek bar with times, TheBoringNotch style. Clickable when the source
// supports seeking; display-only otherwise (tier 2, live streams). The fill
// takes the album-art accent when one is supplied (NotchNook's tinted bar).
function SeekBar({ info, className, accent }: { info: NowPlayingInfo; className?: string; accent?: string }) {
  const { positionSec, durationSec } = info
  if (positionSec === null || !durationSec) {
    return info.source === 'liveRadio' && info.tier === 1 ? (
      <span className={cn('text-[10px] font-semibold uppercase tracking-wider text-destructive', className)}>Live</span>
    ) : null
  }
  const pct = Math.min(100, Math.max(0, (positionSec / durationSec) * 100))
  const seek = info.controls?.seek
  return (
    <div className={className}>
      <div
        role={seek ? 'slider' : 'progressbar'}
        aria-label="Playback position"
        aria-valuenow={Math.round(pct)}
        onClick={seek ? (e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          seek(((e.clientX - r.left) / r.width) * durationSec)
        } : undefined}
        // design-ok(glass-on-plain-bg): seek track inside the black island surface
        className={cn('h-[5px] w-full overflow-hidden rounded-full bg-white/15', seek && 'cursor-pointer')}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-500', !accent && 'bg-white/90')}
          // Album-art accent is per-track DATA, not a UI token.
          // design-ok(hex-in-tsx): album accent color extracted from artwork
          style={{ width: `${pct}%`, ...(accent ? { backgroundColor: accent } : {}) }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-white/45">
        <span>{fmtTime(positionSec)}</span>
        <span>{fmtTime(durationSec)}</span>
      </div>
    </div>
  )
}

function Transport({ info, size, className }: { info: NowPlayingInfo; size: 'sm' | 'md' | 'lg'; className?: string }) {
  const c = info.controls
  const side = size === 'sm' ? 'size-7' : size === 'md' ? 'size-8' : 'size-10'
  const mid = size === 'sm' ? 'size-8' : size === 'md' ? 'size-10' : 'size-11'
  const sideIcon = size === 'sm' ? 'size-3.5' : size === 'md' ? 'size-4' : 'size-6'
  const midIcon = size === 'sm' ? 'size-4' : size === 'md' ? 'size-5' : 'size-7'
  if (!c) {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open player"
        title="Playing elsewhere. Open the app"
        onClick={() => openDeepLink(info)}
        // design-ok(glass-on-plain-bg): sits inside the black island surface
        className={cn(mid, 'rounded-full text-white/80 hover:bg-white/10 hover:text-white', className)}
      >
        <Play className={midIcon} />
      </Button>
    )
  }
  return (
    <div className={cn('flex items-center justify-center', size === 'lg' ? 'gap-4' : 'gap-1', className)}>
      {c.prev && (
        <Button variant="ghost" size="icon" aria-label="Previous" onClick={c.prev}
          // design-ok(glass-on-plain-bg): sits inside the black island surface
          className={cn(side, 'rounded-full text-white/70 hover:bg-white/10 hover:text-white')}>
          <SkipBack className={cn(sideIcon, 'fill-current')} />
        </Button>
      )}
      {c.toggle && (
        <Button variant="ghost" size="icon" aria-label={info.playing ? 'Pause' : 'Play'} onClick={c.toggle}
          // design-ok(glass-on-plain-bg): sits inside the black island surface
          className={cn(mid, 'rounded-full text-white hover:bg-white/10')}>
          {info.playing ? <Pause className={cn(midIcon, 'fill-current')} /> : <Play className={cn(midIcon, 'fill-current')} />}
        </Button>
      )}
      {c.next && (
        <Button variant="ghost" size="icon" aria-label="Next" onClick={c.next}
          // design-ok(glass-on-plain-bg): sits inside the black island surface
          className={cn(side, 'rounded-full text-white/70 hover:bg-white/10 hover:text-white')}>
          <SkipForward className={cn(sideIcon, 'fill-current')} />
        </Button>
      )}
    </div>
  )
}

export function NowPlayingChip({ info }: { info: NowPlayingInfo }) {
  return (
    <button
      type="button"
      aria-label={`Now playing: ${info.title}`}
      title={`${info.title}${info.artist ? ` · ${info.artist}` : ''}`}
      onClick={() => (info.controls?.toggle ? info.controls.toggle() : openDeepLink(info))}
      className="flex items-center gap-1.5"
    >
      <Art info={info} px={18} radius="rounded-[4px]" />
      <SpectroBars playing={info.playing} />
    </button>
  )
}

export function NowPlayingRow({ info }: { info: NowPlayingInfo }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <button type="button" aria-label="Open player" onClick={() => openDeepLink(info)} className="shrink-0">
        <Art info={info} px={52} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-white/95">{info.title}</div>
        {info.artist && <div className="truncate text-xs text-white/50">{info.artist}</div>}
        <SeekBar info={info} className="mt-1" />
      </div>
      <Transport info={info} size="sm" className="shrink-0" />
    </div>
  )
}

// NotchNook/Alcove structure: everything stacked vertically inside the zone.
// Art up top (visualizer picker beside it, Alcove-style), bold title, dim
// artist, slim accent-tinted seek, then a large centered transport row.
export function NowPlayingCard({ info }: { info: NowPlayingInfo }) {
  const palette = useArtPalette(info.artUrl)
  const accent = info.artUrl ? accentOf(palette) : undefined
  const showVisualizerPicker = info.tier === 1 && info.source === 'radio'
  return (
    <div className="flex min-w-0 flex-1 flex-col justify-center">
      <div className="flex items-start justify-between">
        <button type="button" aria-label="Open player" onClick={() => openDeepLink(info)}>
          <Art info={info} px={78} radius="rounded-[14px]" />
        </button>
        {showVisualizerPicker && <VisualizerPicker />}
      </div>
      <div className="mt-2.5 truncate text-lg font-bold leading-tight text-white">{info.title}</div>
      <div className="truncate text-[15px] text-white/50">
        {info.artist ?? (info.tier === 2 ? 'Playing elsewhere' : '')}
      </div>
      <SeekBar info={info} className="mt-2" accent={accent} />
      <Transport info={info} size="lg" className="mt-1.5" />
    </div>
  )
}
