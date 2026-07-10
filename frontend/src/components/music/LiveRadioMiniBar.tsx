import { Pause, Play, X, RadioTower, Volume2, VolumeX } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useLiveRadio } from '@/context/LiveRadioContext'
import { proxyImg } from '@/lib/img'
import { cn } from '@/lib/cn'
import { fmtClock } from '@/lib/youtube/format'
import { AudioVisualizer, useVisualizerPref } from '@/components/shared/AudioVisualizer'
import { paletteFromColors } from '@/lib/music/albumColors'
import { SeekBar } from '@/components/shared/SeekBar'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot } from '@/components/shared/StatusDot'
import { CompactMediaBar } from '@/components/shell/CompactMediaBar'

// design-ok(hex-in-tsx): canvas visualizer + seek accents (warning hue; canvas cannot read CSS vars)
const ACCENT = '#f59e0b'       // amber - matches the live-radio page accents
const ACCENT_DARK = '#b45309'  // design-ok(hex-in-tsx): dark stop for the canvas visualizer gradient
const LIVE_PALETTE = paletteFromColors(ACCENT, ACCENT_DARK)

/**
 * Compact live-internet-radio control shown in the app-wide mini-player slot while a station
 * stream (or a saved recording) plays. The audio itself lives in the global LiveRadioEngine;
 * this is purely a view/controller. Sibling of RadioMiniBar (AI Radio).
 */
export function LiveRadioMiniBar() {
  const live = useLiveRadio()
  const navigate = useNavigate()
  const stripVariant = useVisualizerPref()
  const { mode, station, recording, paused, loading, error, positionSec, durationSec, muted } = live
  const isLive = mode === 'live'
  const canSeek = !isLive && durationSec > 0

  const title = isLive ? (station?.name ?? 'Live Radio') : (recording?.title ?? 'Recording')
  const subtitle = error ?? (isLive ? 'Live Radio' : (recording?.stationName ?? 'Recording'))
  const goTo = () => navigate(isLive ? '/music/live' : '/music/library?tab=radio')

  return (
    <div className="relative z-40 shrink-0">
      {/* design-ok(backdrop-blur-outside-chrome): fixed mini-player chrome, mirrors YoutubeMiniBar */}
      <div className="relative overflow-hidden border-t border-border/60 bg-background/95 backdrop-blur-md shadow-[0_-2px_12px_rgba(0,0,0,0.08)]">
        {/* Live visualizer strip - sits subtly behind the controls, same tap as the AI-Radio bar. */}
        <div className="absolute inset-0 z-0">
          <AudioVisualizer
            variant={stripVariant}
            mode="strip"
            active={!paused && !loading && !error}
            getAnalyser={live.getAnalyser}
            palette={LIVE_PALETTE}
            opacity={0.2}
            fade
          />
        </div>
        {/* Phone: shared compact row (no next for a live stream). */}
        <CompactMediaBar
          art={
            <span className="grid size-full place-items-center bg-gradient-to-br from-warning/30 to-warning/20">
              <RadioTower className="absolute size-5 text-warning/80" />
              {station?.favicon && (
                <img src={proxyImg(station.favicon)} alt="" className="absolute inset-0 size-full object-cover"
                  onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
              )}
            </span>
          }
          title={title}
          subtitle={
            <>
              {isLive && !error && <StatusDot status="error" pulse />}
              <span className={cn('truncate', error && 'text-destructive')}>{subtitle}</span>
            </>
          }
          playing={!paused}
          loading={loading}
          onToggle={live.togglePause}
          onClose={live.stop}
          onExpand={goTo}
          expandLabel={isLive ? 'Open Live Radio' : 'Open recordings'}
        />
        <div className="relative z-10 hidden md:flex items-center gap-3 px-4 py-2">
          {/* Station art - favicon with a radio-tower fallback */}
          {/* design-ok(hand-styled-button): mini-player art tile, mirrors YoutubeMiniBar chrome */}
          <button onClick={goTo}
            className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-control bg-gradient-to-br from-warning/30 to-warning/20"
            aria-label={isLive ? 'Open Live Radio' : 'Open recordings'}>
            <RadioTower className="absolute size-5 text-warning/80" />
            {station?.favicon && (
              <img src={proxyImg(station.favicon)} alt="" className="absolute inset-0 size-full object-cover"
                onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
            )}
            {loading && (
              <div className="absolute inset-0 grid place-items-center bg-black/40">
                <Spinner className="text-white" />
              </div>
            )}
          </button>

          {/* Title + subtitle */}
          <button onClick={goTo} className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm font-semibold">{title}</p>
            <span className="mt-0.5 flex items-center gap-1.5">
              {isLive && !error && <StatusDot status="error" pulse />}
              <span className={cn('truncate text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>{subtitle}</span>
            </span>
          </button>

          {/* Elapsed / remaining - recordings only (live streams have no timeline). */}
          {canSeek && (
            <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
              {fmtClock(positionSec)} / {fmtClock(durationSec)}
            </span>
          )}

          {/* Controls + seek */}
          <div className="flex flex-col items-stretch gap-1.5">
            <div className="flex items-center justify-end gap-1">
              <button onClick={live.toggleMute}
                className={cn('grid size-8 place-items-center rounded-full hover:text-foreground',
                  muted ? 'text-muted-foreground/40' : 'text-muted-foreground')}
                aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'}>
                {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
              </button>
              {/* design-ok(hand-styled-button): mini-player transport control, mirrors YoutubeMiniBar */}
              <button onClick={live.togglePause}
                className="grid size-9 place-items-center rounded-full bg-foreground text-background hover:opacity-90"
                aria-label={paused ? 'Resume' : 'Pause'}>
                {paused ? <Play className="ml-0.5 size-4 fill-current" /> : <Pause className="size-4 fill-current" />}
              </button>
              {/* design-ok(hand-styled-button): mini-player transport control, mirrors YoutubeMiniBar */}
              <button onClick={live.stop}
                className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground"
                aria-label="Stop">
                <X className="size-3.5" />
              </button>
            </div>

            {/* Seek bar - recordings only; a live stream isn't scrubbable. */}
            {canSeek && (
              <SeekBar pos={positionSec} total={durationSec} onSeek={live.seek} accent={ACCENT} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
