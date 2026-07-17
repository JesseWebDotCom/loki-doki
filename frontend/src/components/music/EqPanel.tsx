// Playback sound settings: 10-band graphic EQ (vertical sliders + presets + on/off A/B),
// crossfade length, loudness normalization, and headphone crossfeed. Rendered as a sheet
// from the Now Playing surfaces; every change applies LIVE to the playing audio through
// the shared media graph (see lib/mediaAudioGraph).

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useRadio } from '@/context/RadioContext'
import { EQ_BANDS_HZ } from '@/lib/mediaAudioGraph'
import { EQ_PRESETS, FLAT_EQ } from '@/lib/music/dsp'

const hzLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : String(hz))

export function EqPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const radio = useRadio()
  const { dsp, setDsp, crossfadeMs, setCrossfadeMs, sweetFades, setSweetFades, autoMix, setAutoMix } = radio

  const setBand = (i: number, db: number) => {
    const gains = [...dsp.eqGains]
    gains[i] = db
    // Touching a slider means they want to HEAR it - switch the EQ on implicitly.
    setDsp({ ...dsp, eqGains: gains, eqOn: true })
  }
  const activePreset = EQ_PRESETS.find(p => p.gains.every((g, i) => g === (dsp.eqGains[i] ?? 0)))?.name

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto max-w-2xl rounded-t-sheet border-border/50 pb-8" data-theme="dark"
        // The sheet renders in a portal OUTSIDE MusicLayout's subtree, so the Music app's
        // orange --brand override doesn't reach it - re-pin the identity inline.
        // design-ok(hex-in-tsx): Music app accent tokens re-pinned on a portaled surface
        style={{ '--brand': '#fb923c', '--brand-hover': '#f97316', '--brand-foreground': '#221303' } as React.CSSProperties}>
        <SheetHeader>
          <SheetTitle className="flex items-center justify-between pr-8">
            Sound
            <label className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
              Equalizer
              <Switch checked={dsp.eqOn} onCheckedChange={v => setDsp({ ...dsp, eqOn: v === true })} />
            </label>
          </SheetTitle>
        </SheetHeader>

        {/* Presets */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {EQ_PRESETS.map(p => (
            <button key={p.name} onClick={() => setDsp({ ...dsp, eqGains: [...p.gains], eqOn: p.name !== 'Flat' })}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                activePreset === p.name ? 'bg-brand text-brand-foreground' : 'bg-foreground/8 hover:bg-foreground/15'
              }`}>
              {p.name}
            </button>
          ))}
        </div>

        {/* Band sliders (vertical) */}
        <div className={`mt-4 flex items-end justify-between gap-1 transition-opacity ${dsp.eqOn ? '' : 'opacity-40'}`}>
          {EQ_BANDS_HZ.map((hz, i) => (
            <div key={hz} className="flex flex-1 flex-col items-center gap-1.5">
              <span className="text-[10px] tabular-nums text-muted-foreground">{(dsp.eqGains[i] ?? 0) > 0 ? `+${dsp.eqGains[i]}` : dsp.eqGains[i] ?? 0}</span>
              <input
                type="range" min={-12} max={12} step={1}
                value={dsp.eqGains[i] ?? 0}
                onChange={e => setBand(i, Number(e.target.value))}
                aria-label={`${hzLabel(hz)} Hz`}
                className="eq-slider accent-brand"
                // Vertical slider: rotate a plain range input (writing-mode support varies).
                style={{ writingMode: 'vertical-lr', direction: 'rtl', height: '9rem', width: '1.4rem' }}
              />
              <span className="text-[10px] text-muted-foreground">{hzLabel(hz)}</span>
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setDsp({ ...dsp, eqGains: [...FLAT_EQ] })}>Reset</Button>
        </div>

        {/* Playback settings */}
        <div className="mt-4 space-y-4 border-t border-border/50 pt-4">
          <div>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Crossfade</span>
              <span className="tabular-nums text-muted-foreground">{(crossfadeMs / 1000).toFixed(1)}s</span>
            </div>
            <input type="range" min={0} max={12000} step={250} value={crossfadeMs}
              onChange={e => setCrossfadeMs(Number(e.target.value))}
              aria-label="Crossfade length" className="mt-1.5 w-full accent-brand" />
          </div>
          <label className="flex items-center justify-between text-sm">
            <span>
              <span className="font-medium">Sweet fades</span>
              <span className="block text-xs text-muted-foreground">Each song's loudness picks the best moment to blend in the next one</span>
            </span>
            <Switch checked={sweetFades} onCheckedChange={v => setSweetFades(v === true)} />
          </label>
          <label className="flex items-center justify-between text-sm">
            <span>
              <span className="font-medium">AutoMix</span>
              <span className="block text-xs text-muted-foreground">Beat-matched transitions: when tempos are close, songs blend on the beat with a gentle tempo nudge</span>
            </span>
            <Switch checked={autoMix} onCheckedChange={v => setAutoMix(v === true)} />
          </label>
          <label className="flex items-center justify-between text-sm">
            <span>
              <span className="font-medium">Loudness normalization</span>
              <span className="block text-xs text-muted-foreground">Quiet and loud songs play at a consistent level</span>
            </span>
            <Switch checked={dsp.loudnessOn} onCheckedChange={v => setDsp({ ...dsp, loudnessOn: v === true })} />
          </label>
          <label className="flex items-center justify-between text-sm">
            <span>
              <span className="font-medium">Headphone crossfeed</span>
              <span className="block text-xs text-muted-foreground">Softens hard stereo separation, easier on headphones</span>
            </span>
            <Switch checked={dsp.crossfeed} onCheckedChange={v => setDsp({ ...dsp, crossfeed: v === true })} />
          </label>
        </div>
      </SheetContent>
    </Sheet>
  )
}
