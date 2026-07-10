// Studio project shell: cover/title/lyrics header, the waveform + transport + chord chart +
// key/speed/metronome controls (shared across every sub-tab so you can keep playing, muting
// stems, or slowing the tempo down while following a tab or browsing tutorials), and the
// Mixer/Tab/Tutorials sub-tab bar. The actual StemEngine/Metronome instances live one level up
// in MusicStudioEngineProvider so switching tabs never re-decodes the stems.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useLocation, Outlet, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Play, Pause, RefreshCw, SkipBack, ListVideo, Guitar, SlidersHorizontal } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { AppTabBar, type AppTab } from '@/components/shared/AppTabBar'
import { AudioVisualizer, useVisualizerPref } from '@/components/shared/AudioVisualizer'
import { paletteFromColors } from '@/lib/music/albumColors'
import { WaveSeekBar } from '@/components/music/studio/WaveSeekBar'
import { ChordTimeline } from '@/components/music/studio/ChordTimeline'
import { ActiveChordDiagram } from '@/components/music/studio/ActiveChordDiagram'
import { StudioControls } from '@/components/music/studio/StudioControls'
import { StudioCover } from '@/components/music/studio/StudioCover'
import { LyricsPanel, LyricsTicker } from '@/components/music/nowPlayingParts'
import { acquireAudio } from '@/lib/mediaCoordinator'
import { toast } from '@/lib/toast'
import { getLyrics } from '@/lib/music/catalogApi'
import { reanalyzeStudioTrack } from '@/lib/music/studioApi'
import { type Subdivision } from '@/lib/music/metronome'
import { MusicStudioEngineProvider, useStudioEngine } from '@/context/MusicStudioEngineContext'

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${Math.max(3, Math.min(100, pct))}%` }} />
    </div>
  )
}

const TABS: AppTab<'mixer' | 'tab' | 'tutorials'>[] = [
  { id: 'mixer', label: 'Mixer', icon: SlidersHorizontal },
  { id: 'tab', label: 'Tab', icon: Guitar },
  { id: 'tutorials', label: 'Tutorials', icon: ListVideo },
]

// design-ok(hex-in-tsx): canvas fillStyle cannot consume CSS vars; hue matches --gradient-brand-3
const STUDIO_PALETTE = paletteFromColors('#b06bff')

function StudioShell() {
  const stripVariant = useVisualizerPref()
  const navigate = useNavigate()
  const location = useLocation()
  const { trackId, track, installed, engine, metro, invalidate, vocalsOnsetSec } = useStudioEngine()

  const [, forceRender] = useState(0)
  const [pos, setPos] = useState(0)
  const [scrubbing, setScrubbing] = useState(false)
  const [metroOn, setMetroOn] = useState(false)
  const [metroVol, setMetroVol] = useState(0.7)
  const [metroPan, setMetroPan] = useState(0)
  const [subdivision, setSubdivision] = useState<Subdivision>(1)
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)

  // Subscribe to engine changes (mixer state) + drive a position ticker while playing.
  useEffect(() => {
    const off = engine.onChange(() => forceRender((n) => n + 1))
    let raf = 0
    const tick = () => { if (engine.isPlaying()) setPos(engine.getPosition()); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => { off(); cancelAnimationFrame(raf) }
  }, [engine])

  const lyricsArtist = track?.artist ?? ''
  const lyricsTitle = track?.title ?? ''
  const lyricsDuration = track?.durationSec ?? undefined
  const { data: lyricsData } = useQuery({
    queryKey: ['music-lyrics', lyricsArtist, lyricsTitle, lyricsDuration],
    queryFn: () => getLyrics(lyricsArtist, lyricsTitle, lyricsDuration),
    enabled: !!lyricsTitle, staleTime: Infinity,
  })
  const offsetSec = useMemo(() => {
    if (vocalsOnsetSec == null) return 0
    const firstReal = lyricsData?.synced?.find((l) => l.text.trim())
    if (!firstReal) return 0
    const delta = vocalsOnsetSec - firstReal.sec
    return delta >= -5 && delta <= 60 ? delta : 0
  }, [vocalsOnsetSec, lyricsData])

  if (!track) {
    return (
      <PageContainer width="wide">
        <div className="flex h-64 items-center justify-center"><Spinner /></div>
      </PageContainer>
    )
  }

  const duration = engine.getDuration() || track.durationSec || 0
  const displayPos = scrubbing ? pos : engine.getPosition()
  const mixPeaks = engine.getMixPeaks()
  const runtimeMissing = !installed
  const stemsLen = engine.getStems().length

  const seekTo = (t: number) => { engine.seek(t); setPos(t) }
  const alignedLines = track.lyricsAlignStatus === 'ready' && track.lyrics.length ? track.lyrics : undefined

  async function onReanalyze() {
    setAnalyzing(true)
    try {
      await reanalyzeStudioTrack(trackId)
      toast.success('Re-analysing tempo, key & chords')
      await invalidate()
    } catch { toast.error('Could not re-analyze') }
    finally { setAnalyzing(false) }
  }

  const activeTab = location.pathname.endsWith('/tab') ? 'tab' : location.pathname.endsWith('/tutorials') ? 'tutorials' : 'mixer'

  return (
    <PageContainer width="wide">
      <div className="space-y-3 py-3">
        {runtimeMissing && (
          <Card variant="dashed">
            <div className="py-4 text-center text-sm text-muted-foreground">
              The Studio audio engine isn't installed yet. An admin can enable Music Studio in Admin → Features.
            </div>
          </Card>
        )}

        <Card className="overflow-hidden">
          <div className="flex items-start gap-3 p-3 sm:p-4">
            <Button asChild variant="ghost" size="icon-sm" aria-label="Back to Studio" className="-ml-1 shrink-0 text-muted-foreground">
              <Link to="/music/studio"><ArrowLeft className="size-4" /></Link>
            </Button>
            <StudioCover src={track.coverUrl} artist={track.artist} album={track.title} className="size-16 rounded-card shadow-lg ring-1 ring-border/60" />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-semibold leading-tight text-foreground">{track.title}</h2>
              {track.artist && <p className="truncate text-sm text-muted-foreground">{track.artist}</p>}
            </div>
            {track.sourceStatus === 'ready' && (
              <LyricsTicker artist={track.artist ?? ''} title={track.title} position={displayPos}
                duration={track.durationSec ?? undefined} onOpen={() => setLyricsOpen(true)} offsetSec={offsetSec}
                alignedLines={alignedLines} className="w-56 shrink-0 sm:w-96" />
            )}
          </div>

          {track.sourceStatus !== 'ready' ? (
            <div className="flex flex-col items-center gap-3 px-4 pb-8 text-center">
              {track.sourceStatus === 'failed' ? (
                <p className="text-sm text-destructive">{track.sourceError ?? "Couldn't fetch this song's audio."}</p>
              ) : (
                <>
                  <Spinner />
                  <p className="text-sm text-muted-foreground">{track.sourceProgress?.note ?? 'Fetching audio…'}{track.sourceProgress?.pct ? ` ${track.sourceProgress.pct}%` : ''}</p>
                  {track.sourceProgress?.pct != null && <ProgressBar pct={track.sourceProgress.pct} />}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-2 border-t border-border/50 p-3 sm:p-4">
              <div className="relative h-8 overflow-hidden rounded-control bg-card/40">
                <AudioVisualizer variant={stripVariant} mode="strip" active={engine.isPlaying()}
                  getAnalyser={() => engine.getAnalyser()} palette={STUDIO_PALETTE}
                  className="absolute inset-0" opacity={0.5} fade />
              </div>
              <WaveSeekBar peaks={mixPeaks} position={displayPos} total={duration} onSeek={seekTo} onScrubStateChange={setScrubbing} />

              <div className="flex items-center gap-2">
                <div className="flex shrink-0 items-center gap-2">
                  <Button variant="ghost" size="icon-sm" onClick={() => seekTo(0)} disabled={stemsLen === 0} aria-label="Restart" className="text-muted-foreground"><SkipBack className="size-4" /></Button>
                  <Button size="icon" onClick={() => { if (!engine.isPlaying()) acquireAudio('studio'); engine.toggle() }} disabled={stemsLen === 0} aria-label={engine.isPlaying() ? 'Pause' : 'Play'} className="size-10 rounded-full shadow-md shadow-brand/25">
                    {engine.isPlaying() ? <Pause className="size-5" /> : <Play className="size-5 translate-x-px" />}
                  </Button>
                  <span className="text-xs tabular-nums text-muted-foreground">{fmt(displayPos)} / {fmt(duration)}</span>
                </div>

                {track.chords.length > 0 && <ActiveChordDiagram chords={track.chords} position={displayPos} />}
                <div className="min-w-0 flex-1">
                  {track.chords.length > 0 && <ChordTimeline chords={track.chords} position={displayPos} onSeek={seekTo} />}
                </div>

                <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                  <StudioControls
                    bpm={track.bpm}
                    tempoRatio={engine.getTempoRatio()} onTempoRatio={(r) => engine.setTempoRatio(r)}
                    semitones={engine.getSemitones()} onSemitones={(n) => engine.setSemitones(n)}
                    keyLabel={track.keyLabel}
                    onReset={() => { engine.setTempoRatio(1); engine.setSemitones(0) }}
                    metroOn={metroOn} onMetroToggle={(on) => { setMetroOn(on); on ? metro.enable() : metro.disable() }}
                    metroVol={metroVol} onMetroVol={(v) => { setMetroVol(v); metro.setVolume(v) }}
                    metroPan={metroPan} onMetroPan={(p) => { setMetroPan(p); metro.setPan(p) }}
                    subdivision={subdivision} onSubdivision={(s) => { setSubdivision(s); metro.setSubdivision(s) }}
                  />
                  <Button variant="ghost" size="icon-sm" onClick={() => void onReanalyze()} disabled={analyzing} aria-label="Re-detect tempo, key & chords" className="text-muted-foreground">
                    {analyzing ? <Spinner /> : <RefreshCw className="size-3.5" />}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Card>

        {track.sourceStatus === 'ready' && (
          <AppTabBar tabs={TABS} value={activeTab} onChange={(id) => navigate(id === 'mixer' ? `/music/studio/${trackId}` : `/music/studio/${trackId}/${id}`)} />
        )}

        <Outlet />
      </div>

      <Sheet open={lyricsOpen} onOpenChange={setLyricsOpen}>
        {/* design-ok(adhoc-container): lyrics bottom-sheet sizing, moved verbatim from MusicStudioDetailPage */}
        <SheetContent side="bottom" className="mx-auto flex h-[80vh] max-w-2xl flex-col rounded-t-sheet border-border/50">
          <SheetHeader className="pb-0">
            <SheetTitle>Lyrics</SheetTitle>
          </SheetHeader>
          <div className="relative min-h-0 flex-1">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-sidebar to-transparent" />
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-sidebar to-transparent" />
            <LyricsPanel artist={track.artist ?? ''} title={track.title} position={displayPos} duration={track.durationSec ?? undefined} onSeek={seekTo} offsetSec={offsetSec} alignedLines={alignedLines} />
          </div>
        </SheetContent>
      </Sheet>
    </PageContainer>
  )
}

export function MusicStudioLayout() {
  const { id = '' } = useParams()
  return (
    <MusicStudioEngineProvider trackId={id}>
      <StudioShell />
    </MusicStudioEngineProvider>
  )
}
