import { Pause, Play, SkipForward, X, Loader2, Mic, AudioLines } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useRadio } from '@/context/RadioContext'
import { proxyImg } from '@/lib/img'
import { cn } from '@/lib/cn'
import { fmtClock } from '@/lib/youtube/format'
import { EqVisualizer } from '@/components/shared/EqVisualizer'
import { SeekBar } from '@/components/shared/SeekBar'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'

/**
 * Compact AI-Radio control shown in the app-wide mini-player slot while a station
 * plays and you're away from the Music → AI Radio tab. The audio itself lives in the
 * global RadioEngine; this is purely a view/controller.
 */
export function RadioMiniBar() {
  const radio = useRadio()
  const navigate = useNavigate()
  const { station, currentTrack, djSpeaking, phase, paused, positionSec, durationSec } = radio
  const accent = station?.color ?? '#a855f7'
  // Songs are finite + seekable; only while a track is actually playing (not during DJ talk).
  const canSeek = phase === 'playing' && !djSpeaking && durationSec > 0

  const title = djSpeaking ? 'On the mic…' : (currentTrack?.title ?? station?.label ?? 'AI Radio')
  const subtitle = djSpeaking ? `${station?.label ?? 'Radio'} DJ` : (currentTrack?.author ?? station?.genre ?? 'Live')
  const busy = phase === 'loading'

  return (
    <div className="relative z-40 shrink-0">
      <div className="relative overflow-hidden border-t border-border/60 bg-background/95 backdrop-blur-md shadow-[0_-2px_12px_rgba(0,0,0,0.08)]">
        {/* Live faux-EQ — sits subtly behind the controls, tinted to the station accent. */}
        {radio.visualizerEnabled && (
          <div className="absolute inset-0 z-0">
            <EqVisualizer
              active={!paused && (phase === 'playing' || djSpeaking)}
              getAnalyser={radio.getAnalyser}
              color={station?.color ?? '#a855f7'}
              colorDark={station?.colorDark ?? '#6d28d9'}
              opacity={0.2}
              fade
            />
          </div>
        )}
        <div className="relative z-10 flex items-center gap-3 px-4 py-2">
          {/* Now-playing art — current track thumbnail, station emoji as fallback */}
          <button onClick={() => navigate('/music/now-playing')}
            className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-md text-2xl leading-none"
            style={{ background: station ? `linear-gradient(135deg, ${station.color}, ${station.colorDark})` : undefined }}
            aria-label="Open AI Radio">
            {currentTrack?.thumbnail && (
              <img src={proxyImg(currentTrack.thumbnail)} alt="" className="absolute inset-0 size-full object-cover" />
            )}
            {djSpeaking && currentTrack?.thumbnail && <div className="absolute inset-0 bg-black/45" />}
            {djSpeaking
              ? <Mic className="relative size-4 text-white drop-shadow" />
              : !currentTrack?.thumbnail && <span className="relative">{station?.emoji ?? '📻'}</span>}
            {busy && (
              <div className="absolute inset-0 grid place-items-center bg-black/40">
                <Loader2 className="size-4 animate-spin text-white" />
              </div>
            )}
          </button>

          {/* Title + subtitle */}
          <button onClick={() => navigate('/music/now-playing')} className="min-w-0 flex-1 text-left">
            <p className="truncate text-sm font-semibold">{title}</p>
            <span className="mt-0.5 flex items-center gap-1.5">
              <span className="inline-flex size-1.5 animate-pulse rounded-full bg-red-500" />
              <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
            </span>
          </button>

          {/* Elapsed / remaining — same readout as the YouTube mini-player. */}
          {canSeek && (
            <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
              {fmtClock(positionSec)} / {fmtClock(durationSec)}
            </span>
          )}

          {/* Controls + seek */}
          <div className="flex flex-col items-stretch gap-1.5">
            <div className="flex items-center justify-end gap-1">
              <button onClick={radio.toggleVisualizer}
                className={cn('grid size-8 place-items-center rounded-full hover:text-foreground',
                  radio.visualizerEnabled ? 'text-muted-foreground' : 'text-muted-foreground/40')}
                aria-label={radio.visualizerEnabled ? 'Hide visualizer' : 'Show visualizer'}
                title={radio.visualizerEnabled ? 'Visualizer on' : 'Visualizer off'}>
                <AudioLines className="size-4" />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className={cn('grid size-8 place-items-center rounded-full hover:text-foreground',
                    (station?.djMode ?? 'full') === 'silent' ? 'text-muted-foreground/40' : 'text-muted-foreground')}
                    aria-label="DJ mode" title="DJ mode">
                    <Mic className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {([['full', 'Full DJ'], ['minimal', 'DJ minimal'], ['silent', 'Silent (no DJ)']] as const).map(([mode, label]) => (
                    <DropdownMenuItem key={mode} onClick={() => radio.setDjMode(mode)}>
                      {(station?.djMode ?? 'full') === mode ? '✓ ' : ''}{label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <button onClick={radio.togglePause}
                className="grid size-9 place-items-center rounded-full bg-foreground text-background hover:opacity-90"
                aria-label={paused ? 'Resume' : 'Pause'}>
                {paused ? <Play className="ml-0.5 size-4 fill-current" /> : <Pause className="size-4 fill-current" />}
              </button>
              <button onClick={radio.skip} disabled={phase !== 'playing'}
                className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-30"
                aria-label="Skip">
                <SkipForward className="size-4" />
              </button>
              <button onClick={radio.stop}
                className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground"
                aria-label="Stop radio">
                <X className="size-3.5" />
              </button>
            </div>

            {/* Seek bar — the same control the YouTube mini-player uses. */}
            <SeekBar pos={positionSec} total={durationSec} onSeek={radio.seek} accent={accent} disabled={!canSeek} />
          </div>
        </div>
      </div>
    </div>
  )
}
