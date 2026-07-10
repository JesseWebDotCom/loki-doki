// Studio "Mixer" tab: the stems mixer / generate-stems CTA. Header, transport, chords, and
// key/speed/metronome controls are shared across every sub-tab and live in MusicStudioLayout.tsx;
// the engine itself lives one level up in MusicStudioEngineContext so switching to the Tab or
// Tutorials sub-tab never re-decodes the stems.
import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { generateStems, type StemModel, type CustomStem } from '@/lib/music/studioApi'
import { StemMixer, type MixerStem } from '@/components/music/studio/StemMixer'
import { StemOptionsSheet } from '@/components/music/studio/StemOptionsSheet'
import { useStudioEngine } from '@/context/MusicStudioEngineContext'

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${Math.max(3, Math.min(100, pct))}%` }} />
    </div>
  )
}

export function MusicStudioDetailPage() {
  const { track, installed, guitarEnhanced, engine, invalidate } = useStudioEngine()
  const [optionsOpen, setOptionsOpen] = useState(false)

  if (!track || track.sourceStatus !== 'ready') return null

  const stems: MixerStem[] = engine.getStems().map((s) => ({ name: s.name, volume: s.volume, muted: s.muted, peaks: s.peaks }))
  const duration = engine.getDuration() || track.durationSec || 0
  const progressFrac = duration > 0 ? engine.getPosition() / duration : 0
  const loadedStems = track.stemStatus === 'ready' && stems.length > 0
  const separating = track.stemStatus === 'separating' || track.stemStatus === 'pending'
  const runtimeMissing = !installed

  async function onGenerate(req: { model?: StemModel; stems?: CustomStem[]; enhancedGuitar?: boolean }) {
    try {
      await generateStems(track!.id, req)
      toast.success('Generating stems')
      // Refetch so the UI immediately sees stemStatus flip to 'pending'/'separating' (that's
      // what turns the poll on); otherwise the cached idle status keeps polling off until a reload.
      await invalidate()
    } catch { toast.error('Could not start separation') }
  }

  return (
    <>
      {loadedStems ? (
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
              onSeek={(frac) => engine.seek(frac * duration)}
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

      <StemOptionsSheet open={optionsOpen} onOpenChange={setOptionsOpen} onGenerate={onGenerate} guitarEnhanced={guitarEnhanced} />
    </>
  )
}
