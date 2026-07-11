import { Pause, Play, SkipForward, X, Mic, Mic2, AudioLines, MonitorPlay, Maximize2, RotateCcw, RotateCw, Repeat1 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useRadio } from '@/context/RadioContext'
import { usePlayerOverlay } from '@/context/PlayerOverlayContext'
import { useCatalogNav } from '@/lib/music/catalogNav'
import { proxyImg } from '@/lib/img'
import { useSongArt } from '@/components/music/SongArt'
import { cn } from '@/lib/cn'
import { isYouTubeRef } from '@/lib/music/trackRef'
import { queueForKaraoke } from '@/lib/music/karaokeQueue'
import { fmtClock } from '@/lib/youtube/format'
import { useWaveform } from '@/lib/music/metaApi'
import { useArtPalette, accentOf, readableOn, paletteFromColors } from '@/lib/artPalette'
import { AudioVisualizer, VISUALIZERS, useVisualizerPref, setVisualizerPref } from '@/components/shared/AudioVisualizer'
import { SeekBar } from '@/components/shared/SeekBar'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot } from '@/components/shared/StatusDot'
import { useTitleMask } from '@/lib/music/policy'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { CompactMediaBar } from '@/components/shell/CompactMediaBar'

// Scene selector right on the bar (both breakpoints) - changing the visual must not
// require opening the full player. Same shared pref as everywhere else (None + every
// scene; each has a purpose-built strip form).
function VisualizerMenu({ triggerClass }: { triggerClass: string }) {
  const radio = useRadio()
  const stripVariant = useVisualizerPref()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={triggerClass}
          aria-label="Visualizer"
          title={radio.visualizerEnabled ? `Visualizer: ${VISUALIZERS.find(v => v.id === stripVariant)?.label}` : 'Visualizer: off'}>
          <AudioLines className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => { if (radio.visualizerEnabled) radio.toggleVisualizer() }}>
          {!radio.visualizerEnabled ? '✓ ' : ''}None
        </DropdownMenuItem>
        {VISUALIZERS.map(v => (
          <DropdownMenuItem key={v.id} onClick={() => { setVisualizerPref(v.id); if (!radio.visualizerEnabled) radio.toggleVisualizer() }}>
            {radio.visualizerEnabled && v.id === stripVariant ? '✓ ' : ''}{v.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Compact AI-Radio control shown in the app-wide mini-player slot while a station
 * plays and you're away from the Music → AI Radio tab. The audio itself lives in the
 * global RadioEngine; this is purely a view/controller.
 */
export function RadioMiniBar() {
  const radio = useRadio()
  const navigate = useNavigate()
  const { openPlayer } = usePlayerOverlay()
  const stripVariant = useVisualizerPref()
  const cat = useCatalogNav()
  const { station, currentTrack, djSpeaking, phase, paused, positionSec, durationSec, skipping } = radio
  // Real square album art when it resolves; the video thumbnail stays as the instant fallback.
  const miniArt = useSongArt(currentTrack?.videoId, currentTrack?.title, currentTrack?.author)
  // Plexamp-style album persona: seek/EQ/play pick up the cover's accent; a monochrome
  // cover falls back to the station colour so the bar never goes grey-on-grey.
  const palette = useArtPalette(miniArt ?? (currentTrack?.thumbnail ? proxyImg(currentTrack.thumbnail) : null))
  // Loudness envelope for the strip Soundprint (cached; radioEngine prefetches it per track).
  const stripPeaks = useWaveform(currentTrack?.videoId)
  // design-ok(hex-in-tsx): canvas/seek accent fallback - EqVisualizer + SeekBar take literal colors
  const accent = palette.muted ? (station?.color ?? '#fb923c') : accentOf(palette)
  // Songs are finite + seekable; only while a track is actually playing (not during DJ talk).
  const canSeek = phase === 'playing' && !djSpeaking && durationSec > 0

  // Show the (current) song even while the DJ talks - the art/title update in sync with the DJ's
  // voice; the mic state is conveyed by the subtitle + a small badge on the art, not by masking it.
  const mask = useTitleMask()
  const title = mask(currentTrack?.title ?? station?.label ?? 'AI Radio')
  const subtitle = djSpeaking ? 'On the mic…' : (currentTrack?.author ?? station?.genre ?? 'Live')
  // The subtitle is a clickable artist link only when it actually shows the track's artist.
  const artistLink = !djSpeaking && !!currentTrack?.author
  const busy = phase === 'loading'

  return (
    <div className="relative z-40 shrink-0">
      {/* design-ok(backdrop-blur-outside-chrome): fixed mini-player chrome, mirrors YoutubeMiniBar */}
      <div className="relative overflow-hidden border-t border-border/60 bg-background/95 backdrop-blur-md shadow-[0_-2px_12px_rgba(0,0,0,0.08)]">
        {/* UltraBlur wash: a whisper of the album's corner colours across the bar, so the
            mini player carries the song's persona like the full players do. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0 opacity-[0.16] dark:opacity-25"
          style={{ background: `linear-gradient(90deg, ${palette.corners[0]}, ${palette.corners[1]} 35%, transparent 60%, ${palette.corners[3]})` }} />
        {/* Live visualizer strip - sits subtly behind the controls, tinted to the album
            persona (style chosen via the Now Playing menu, shared by every strip). A
            monochrome cover falls back to the station's own colors so it never goes grey. */}
        {radio.visualizerEnabled && (
          <div className="absolute inset-0 z-0">
            <AudioVisualizer
              variant={stripVariant}
              mode="strip"
              active={!paused && (phase === 'playing' || djSpeaking)}
              getAnalyser={radio.getAnalyser}
              palette={palette.muted && station ? paletteFromColors(station.color, station.colorDark) : palette}
              peaks={stripPeaks}
              progress={durationSec > 0 ? positionSec / durationSec : 0}
              opacity={0.2}
              fade
            />
          </div>
        )}
        {/* Phone: shared compact row; everything else lives in the full player overlay. */}
        <CompactMediaBar
          art={
            <span className="grid size-full place-items-center text-xl leading-none"
              style={{ background: station ? `linear-gradient(135deg, ${station.color}, ${station.colorDark})` : undefined }}>
              {(miniArt || currentTrack?.thumbnail) ? (
                <img src={miniArt ?? proxyImg(currentTrack!.thumbnail)} alt="" className="absolute inset-0 size-full object-cover" />
              ) : (
                <span className="relative">{station?.emoji ?? '📻'}</span>
              )}
            </span>
          }
          title={title}
          subtitle={
            <>
              <StatusDot status="error" pulse />
              <span className="truncate">{subtitle}</span>
            </>
          }
          playing={!paused}
          loading={busy}
          onToggle={radio.togglePause}
          onNext={phase === 'playing' && !skipping ? radio.skip : undefined}
          onClose={radio.stop}
          onExpand={() => openPlayer()}
          expandLabel="Open full player"
          extra={<VisualizerMenu triggerClass={cn('grid size-10 shrink-0 place-items-center rounded-full',
            radio.visualizerEnabled ? 'text-muted-foreground' : 'text-muted-foreground/40')} />}
          accent={accent}
          accentText={readableOn(accent)}
        />
        <div className="relative z-10 hidden md:flex items-center gap-3 px-4 py-2">
          {/* Now-playing art - current track thumbnail, station emoji as fallback */}
          <button onClick={() => openPlayer()}
            className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-control text-2xl leading-none"
            style={{ background: station ? `linear-gradient(135deg, ${station.color}, ${station.colorDark})` : undefined }}
            aria-label="Open full player">
            {(miniArt || currentTrack?.thumbnail) && (
              <img src={miniArt ?? proxyImg(currentTrack!.thumbnail)} alt="" className="absolute inset-0 size-full object-cover" />
            )}
            {!currentTrack?.thumbnail && <span className="relative">{station?.emoji ?? '📻'}</span>}
            {/* DJ talking - small corner badge so the song art stays visible underneath. */}
            {djSpeaking && (
              <span className="absolute bottom-0 right-0 grid size-4 place-items-center rounded-tl-md bg-black/70">
                <Mic className="size-2.5 text-white" />
              </span>
            )}
            {busy && (
              <div className="absolute inset-0 grid place-items-center bg-black/40">
                <Spinner className="text-white" />
              </div>
            )}
          </button>

          {/* Title + subtitle. Title opens the full now-playing view; the artist subtitle (when it's
              a real artist, not "On the mic…"/"Live") opens that artist's in-app MB detail page. */}
          <div className="min-w-0 flex-1">
            <button onClick={() => openPlayer()} className="block max-w-full text-left">
              <p className="truncate text-sm font-semibold">{title}</p>
            </button>
            <span className="mt-0.5 flex items-center gap-1.5">
              <StatusDot status="error" pulse />
              {artistLink ? (
                <button onClick={() => cat.openArtist(currentTrack!.author!)} disabled={cat.pending === 'artist'}
                  className="truncate text-left text-xs text-muted-foreground transition hover:text-foreground hover:underline disabled:opacity-60"
                  title="View artist details">{subtitle}</button>
              ) : (
                <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
              )}
            </span>
          </div>

          {/* Elapsed / remaining - same readout as the YouTube mini-player. */}
          {canSeek && (
            <span className="hidden text-xs tabular-nums text-muted-foreground sm:block">
              {fmtClock(positionSec)} / {fmtClock(durationSec)}
            </span>
          )}

          {/* Controls + seek */}
          <div className="flex flex-col items-stretch gap-1.5">
            <div className="flex items-center justify-end gap-1">
              <VisualizerMenu triggerClass={cn('grid size-8 place-items-center rounded-full hover:text-foreground',
                radio.visualizerEnabled ? 'text-muted-foreground' : 'text-muted-foreground/40')} />
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
              <button onClick={() => navigate(station?.stationId ? `/music/watch/${station.stationId}` : '/music/watch/current')}
                className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground"
                aria-label="Watch video" title="Switch to video">
                <MonitorPlay className="size-4" />
              </button>
              {currentTrack && isYouTubeRef(currentTrack.videoId) && (
                <button onClick={() => { queueForKaraoke({ videoId: currentTrack.videoId, title: currentTrack.title, artist: currentTrack.author ?? '', durationSec: durationSec || null }); navigate('/music/karaoke') }}
                  className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground"
                  aria-label="Sing in karaoke" title="Karaoke this song">
                  <Mic2 className="size-4" />
                </button>
              )}
              <button onClick={() => openPlayer()}
                className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground"
                aria-label="Fullscreen player" title="Fullscreen">
                <Maximize2 className="size-4" />
              </button>
              {/* design-ok(hand-styled-button): mini-player transport control, mirrors YoutubeMiniBar */}
              <button onClick={() => radio.seekBy(-15)} disabled={phase !== 'playing'}
                className="hidden size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-30 sm:grid"
                aria-label="Back 15 seconds" title="Back 15s">
                <RotateCcw className="size-4" />
              </button>
              {/* design-ok(hand-styled-button): mini-player transport control, mirrors YoutubeMiniBar */}
              <button onClick={radio.togglePause}
                className="grid size-9 place-items-center rounded-full hover:opacity-90"
                style={{ background: accent, color: readableOn(accent) }}
                aria-label={paused ? 'Resume' : 'Pause'}>
                {paused ? <Play className="ml-0.5 size-4 fill-current" /> : <Pause className="size-4 fill-current" />}
              </button>
              {/* design-ok(hand-styled-button): mini-player transport control, mirrors YoutubeMiniBar */}
              <button onClick={() => radio.seekBy(30)} disabled={phase !== 'playing'}
                className="hidden size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-30 sm:grid"
                aria-label="Forward 30 seconds" title="Skip ahead 30s (e.g. past an ad)">
                <RotateCw className="size-4" />
              </button>
              {/* design-ok(hand-styled-button): mini-player transport control, mirrors YoutubeMiniBar */}
              <button onClick={radio.skip} disabled={phase !== 'playing' || skipping}
                className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground disabled:opacity-30"
                aria-label="Skip">
                {skipping ? <Spinner className="text-current" /> : <SkipForward className="size-4" />}
              </button>
              {/* design-ok(hand-styled-button): mini-player transport control, mirrors YoutubeMiniBar */}
              <button onClick={() => radio.setRepeatOne(!radio.repeatOne)}
                className={cn('hidden size-8 place-items-center rounded-full hover:text-foreground sm:grid', radio.repeatOne ? 'text-brand' : 'text-muted-foreground')}
                aria-label="Repeat one" title={radio.repeatOne ? 'Repeat on' : 'Repeat off'}>
                <Repeat1 className="size-4" />
              </button>
              {/* design-ok(hand-styled-button): mini-player transport control, mirrors YoutubeMiniBar */}
              <button onClick={radio.stop}
                className="grid size-8 place-items-center rounded-full text-muted-foreground hover:text-foreground"
                aria-label="Stop radio">
                <X className="size-3.5" />
              </button>
            </div>

            {/* Seek bar - the same control the YouTube mini-player uses. */}
            <SeekBar pos={positionSec} total={durationSec} onSeek={radio.seek} accent={accent} disabled={!canSeek} />
          </div>
        </div>
      </div>
    </div>
  )
}
