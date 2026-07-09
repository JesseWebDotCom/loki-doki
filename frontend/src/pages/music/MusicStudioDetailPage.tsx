// Music Studio detail: the multitrack stem player + practice tools for one track.
// Orchestrates the StemEngine (playback/mixer) and Metronome, polls the backend while
// analysis/separation jobs run, and renders the mixer, chord row, metronome, and
// key/speed controls. Mirrors the reference Moises screens.
import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Play, Pause, Sparkles, RefreshCw, SkipBack } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { EqVisualizer } from '@/components/shared/EqVisualizer'
import { WaveSeekBar } from '@/components/music/studio/WaveSeekBar'
import { toast } from '@/lib/toast'
import { getStudioTrack, generateStems, reanalyzeStudioTrack, type StemModel, type CustomStem } from '@/lib/music/studioApi'
import { StemEngine } from '@/lib/music/stemEngine'
import { Metronome, type Subdivision } from '@/lib/music/metronome'
import { StemMixer, type MixerStem } from '@/components/music/studio/StemMixer'
import { ChordTimeline } from '@/components/music/studio/ChordTimeline'
import { StudioControls } from '@/components/music/studio/StudioControls'
import { StemOptionsSheet } from '@/components/music/studio/StemOptionsSheet'
import { StudioCover } from '@/components/music/studio/StudioCover'
import { LyricsPanel } from '@/components/music/nowPlayingParts'

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

export function MusicStudioDetailPage() {
  const { id = '' } = useParams()
  const qc = useQueryClient()
  const loadedKeyRef = useRef<string>('')
  // StrictMode dev-mounts twice (mount → dispose → remount). The dispose-on-unmount effect
  // kills the engine, so on remount we must build a FRESH one (a disposed engine loads
  // nothing → empty mixer) and reset the load key so the load effect reloads into it.
  const engineRef = useRef<StemEngine>()
  if (!engineRef.current || engineRef.current.isDisposed()) { engineRef.current = new StemEngine(); loadedKeyRef.current = '' }
  const engine = engineRef.current

  // Metronome getters read engineRef.current so they always target the CURRENT engine even
  // after a StrictMode recreate.
  const metroRef = useRef<Metronome>()
  if (!metroRef.current || metroRef.current.isDisposed()) metroRef.current = new Metronome(() => engineRef.current!.getPosition(), () => engineRef.current!.isPlaying())
  const metro = metroRef.current

  const [, forceRender] = useState(0)
  const [pos, setPos] = useState(0)
  const [scrubbing, setScrubbing] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [metroOn, setMetroOn] = useState(false)
  const [metroVol, setMetroVol] = useState(0.7)
  const [metroPan, setMetroPan] = useState(0)
  const [subdivision, setSubdivision] = useState<Subdivision>(1)
  const [loadedMode, setLoadedMode] = useState<'stems' | 'preview' | null>(null)

  const { data } = useQuery({
    queryKey: ['studio-track', id],
    queryFn: () => getStudioTrack(id),
    refetchInterval: (q) => {
      const t = q.state.data?.track
      const busy = t && (t.sourceStatus === 'fetching'
        || t.analysisStatus === 'pending' || t.analysisStatus === 'analyzing'
        || t.stemStatus === 'pending' || t.stemStatus === 'separating')
      return busy ? 3000 : false
    },
  })
  const track = data?.track

  // Subscribe to engine changes (mixer state) + drive a position ticker while playing.
  useEffect(() => {
    const off = engine.onChange(() => forceRender((n) => n + 1))
    let raf = 0
    const tick = () => { if (engine.isPlaying()) setPos(engine.getPosition()); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => { off(); cancelAnimationFrame(raf) }
  }, [engine])

  // Tear the engine + metronome down on unmount.
  useEffect(() => () => { engineRef.current?.dispose(); metroRef.current?.dispose() }, [])

  // Push the analysed beat grid into the metronome.
  useEffect(() => { if (track?.beats) metro.setBeats(track.beats) }, [track?.beats, metro])

  // Feed the engine: prefer the separated stems once ready; otherwise load the original
  // source mix so the user can still press play and check the track before generating stems.
  // Guarded by a key so the same set isn't reloaded on every poll.
  useEffect(() => {
    if (!track) return
    if (track.stemStatus === 'ready' && track.stems.length > 0) {
      const key = 'stems|' + track.stems.map((s) => s.url).join('|')
      if (loadedKeyRef.current === key) return
      loadedKeyRef.current = key
      void engine.load(track.stems).then(() => setLoadedMode('stems')).catch(() => toast.error('Could not load stems'))
    } else if (track.sourceStatus === 'ready') {
      const url = `/api/music/studio/${track.id}/source`
      const key = 'preview|' + url
      if (loadedKeyRef.current === key) return
      loadedKeyRef.current = key
      void engine.load([{ name: 'original', url }]).then(() => setLoadedMode('preview')).catch(() => toast.error('Could not load audio'))
    }
  }, [track, engine])

  const stems: MixerStem[] = engine.getStems().map((s) => ({ name: s.name, volume: s.volume, muted: s.muted, peaks: s.peaks }))
  const duration = engine.getDuration() || track?.durationSec || 0
  const displayPos = scrubbing ? pos : engine.getPosition()
  const progressFrac = duration > 0 ? displayPos / duration : 0
  const mixPeaks = engine.getMixPeaks()

  const runtimeMissing = data && !data.installed
  const separating = track?.stemStatus === 'separating' || track?.stemStatus === 'pending'
  const analyzing = track?.analysisStatus === 'analyzing' || track?.analysisStatus === 'pending'

  async function onGenerate(req: { model?: StemModel; stems?: CustomStem[]; enhancedGuitar?: boolean }) {
    if (!track) return
    try {
      await generateStems(track.id, req)
      toast.success('Generating stems')
      // Refetch so the UI immediately sees stemStatus flip to 'pending'/'separating' (that's
      // what turns the poll on); otherwise the cached idle status keeps polling off until a reload.
      await qc.invalidateQueries({ queryKey: ['studio-track', id] })
    } catch { toast.error('Could not start separation') }
  }

  async function onReanalyze() {
    if (!track) return
    try {
      await reanalyzeStudioTrack(track.id)
      toast.success('Re-analysing tempo, key & chords')
      await qc.invalidateQueries({ queryKey: ['studio-track', id] })
    } catch { toast.error('Could not re-analyze') }
  }

  if (!track) {
    return (
      <PageContainer width="wide">
        <div className="flex h-64 items-center justify-center"><Spinner /></div>
      </PageContainer>
    )
  }

  const seekTo = (t: number) => { engine.seek(t); setPos(t) }

  return (
    <PageContainer width="wide">
      <div className="space-y-3 py-3">
        {runtimeMissing && (
          <Card variant="dashed">
            <CardContent className="py-4 text-center text-sm text-muted-foreground">
              The Studio audio engine isn't installed yet. An admin can enable Music Studio in Admin → Features.
            </CardContent>
          </Card>
        )}

        {/* ── Sleek now-playing header: cover · title · integrated transport · controls ── */}
        <Card className="overflow-hidden">
          <div className="flex items-start gap-3 p-3 sm:p-4">
            <Button asChild variant="ghost" size="icon-sm" aria-label="Back to Studio" className="-ml-1 shrink-0 text-muted-foreground">
              <Link to="/music/studio"><ArrowLeft className="size-4" /></Link>
            </Button>
            <StudioCover src={track.coverUrl} artist={track.artist} album={track.title} className="size-16 rounded-card shadow-lg ring-1 ring-border/60" />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-semibold leading-tight text-foreground">{track.title}</h2>
              {track.artist && <p className="truncate text-sm text-muted-foreground">{track.artist}</p>}
              {track.sourceStatus === 'ready' && (
                <div className="mt-2 flex items-center gap-2">
                  <Button variant="ghost" size="icon-sm" onClick={() => seekTo(0)} disabled={stems.length === 0} aria-label="Restart" className="text-muted-foreground"><SkipBack className="size-4" /></Button>
                  <Button size="icon" onClick={() => engine.toggle()} disabled={stems.length === 0} aria-label={engine.isPlaying() ? 'Pause' : 'Play'} className="size-10 rounded-full shadow-md shadow-brand/25">
                    {engine.isPlaying() ? <Pause className="size-5" /> : <Play className="size-5 translate-x-px" />}
                  </Button>
                  <span className="text-xs tabular-nums text-muted-foreground">{fmt(displayPos)} / {fmt(duration)}</span>
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              {track.sourceStatus === 'ready' && (
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
              )}
              <Button variant="ghost" size="icon-sm" onClick={onReanalyze} disabled={analyzing} aria-label="Re-detect tempo, key & chords" className="text-muted-foreground">
                {analyzing ? <Spinner /> : <RefreshCw className="size-3.5" />}
              </Button>
            </div>
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
                <EqVisualizer active={engine.isPlaying()} getAnalyser={() => engine.getAnalyser()} className="absolute inset-0" opacity={0.5} fade />
              </div>
              <WaveSeekBar peaks={mixPeaks} position={displayPos} total={duration} onSeek={seekTo} onScrubStateChange={setScrubbing} />
              {track.chords.length > 0 && <ChordTimeline chords={track.chords} position={displayPos} onSeek={seekTo} />}
            </div>
          )}
        </Card>

        {track.sourceStatus === 'ready' && (<>
          {/* ── Stems mixer / generate CTA ── */}
          {loadedMode === 'stems' ? (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 p-3 pb-1">
                <CardTitle className="text-sm text-muted-foreground">Stems</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setOptionsOpen(true)} disabled={separating} className="text-muted-foreground">
                  <Sparkles className="size-4" /> Re-stem
                </Button>
              </CardHeader>
              <CardContent className="p-3 pt-1">
                <StemMixer
                  stems={stems}
                  soloName={engine.getSolo()}
                  progress={progressFrac}
                  onVolume={(n, v) => engine.setStemVolume(n, v)}
                  onMute={(n, m) => engine.setMuted(n, m)}
                  onSolo={(n) => engine.toggleSolo(n)}
                  onSeek={(frac) => seekTo(frac * duration)}
                />
              </CardContent>
            </Card>
          ) : (
            <Card variant="dashed">
              <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
                {separating ? (
                  <>
                    <Spinner />
                    <p className="text-sm text-muted-foreground">{track.stemProgress?.note ?? 'Separating stems…'}{track.stemProgress?.pct ? ` ${track.stemProgress.pct}%` : ''}</p>
                    <ProgressBar pct={track.stemProgress?.pct ?? 0} />
                    <p className="text-xs text-muted-foreground">This can take a few minutes.</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">Split this track into individual instruments.</p>
                    <Button onClick={() => setOptionsOpen(true)} disabled={runtimeMissing}><Sparkles className="size-4" /> Generate AI Stems</Button>
                    {track.stemStatus === 'failed' && <p className="text-xs text-destructive">{track.stemError ?? 'Separation failed.'}</p>}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Lyrics, synced to playback position ── */}
          <Card>
            <CardHeader className="p-3 pb-1">
              <CardTitle className="text-sm text-muted-foreground">Lyrics</CardTitle>
            </CardHeader>
            <CardContent className="relative h-72 overflow-hidden p-0">
              <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 rounded-t-card bg-gradient-to-b from-card to-transparent" />
              <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 rounded-b-card bg-gradient-to-t from-card to-transparent" />
              <LyricsPanel artist={track.artist ?? ''} title={track.title} position={displayPos} duration={track.durationSec ?? undefined} onSeek={seekTo} />
            </CardContent>
          </Card>
        </>)}
      </div>

      <StemOptionsSheet open={optionsOpen} onOpenChange={setOptionsOpen} onGenerate={onGenerate} guitarEnhanced={data?.guitarEnhanced} />
    </PageContainer>
  )
}
