// LANDR-style stem mixer: one colour-tinted card per stem. Label + round mute/solo buttons
// on the left, a colour-matched clickable waveform on the right, and a slim colour-matched
// volume fader beneath it.
import { VolumeX, Volume2, Headphones } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { stemInfo } from './stemMeta'
import { StemWaveform } from './StemWaveform'

export interface MixerStem { name: string; volume: number; muted: boolean; peaks: number[] }

interface Props {
  stems: MixerStem[]
  soloName: string | null
  progress: number
  onVolume: (name: string, v: number) => void
  onMute: (name: string, muted: boolean) => void
  onSolo: (name: string) => void
  onSeek?: (fraction: number) => void
}

export function StemMixer({ stems, soloName, progress, onVolume, onMute, onSolo, onSeek }: Props) {
  return (
    <div className="space-y-2">
      {stems.map((s) => {
        const info = stemInfo(s.name)
        const Icon = info.icon
        const soloed = soloName === s.name
        const dimmed = soloName != null && !soloed
        const active = !s.muted && !dimmed
        return (
          <div
            key={s.name}
            className={cn('flex items-center gap-3 rounded-card p-2.5 transition-opacity', dimmed && 'opacity-50')}
            style={{ backgroundColor: `${info.color}14`, boxShadow: `inset 3px 0 0 ${info.color}` }}
          >
            {/* left: label + mute/solo */}
            <div className="flex w-24 shrink-0 flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <Icon className="size-3.5 shrink-0" style={{ color: info.color }} />
                <span className="truncate text-xs font-semibold text-foreground">{info.label}</span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost" size="icon-sm" onClick={() => onMute(s.name, !s.muted)} aria-pressed={s.muted}
                  aria-label={`Mute ${info.label}`}
                  className={cn('size-7 rounded-full', s.muted && 'bg-destructive/15 text-destructive hover:bg-destructive/20')}
                >{s.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}</Button>
                <Button
                  variant="ghost" size="icon-sm" onClick={() => onSolo(s.name)} aria-pressed={soloed}
                  aria-label={`Solo ${info.label}`}
                  className={cn('size-7 rounded-full', soloed && 'text-brand')}
                  style={soloed ? { backgroundColor: `${info.color}26` } : undefined}
                ><Headphones className="size-3.5" /></Button>
              </div>
            </div>
            {/* right: waveform + volume */}
            <div className="min-w-0 flex-1 space-y-1.5">
              <StemWaveform peaks={s.peaks} progress={progress} active={active} color={info.color} onSeek={onSeek} className="h-10 w-full" />
              <input
                type="range" min={0} max={1} step={0.01}
                value={s.muted ? 0 : s.volume}
                onChange={(e) => onVolume(s.name, Number(e.target.value))}
                aria-label={`${info.label} volume`}
                className="h-1 w-full cursor-pointer"
                style={{ accentColor: info.color }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
