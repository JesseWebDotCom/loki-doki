// The fireplace channel: a pure CSS/SVG hearth. Layered flame blobs flicker
// over a near-black gradient with a few rising embers. All colors derive from
// the channel accent so the scene follows the channel's palette.

import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'
import type { TvChannel } from '@/lib/maipaitv/api'
import type { TvScreenProps } from './index'
import { ScreenEyebrow } from './shared'

const KEYFRAMES = `
@keyframes maipaitv-flame {
  0% { transform: scaleY(1) scaleX(1) translateY(0); border-radius: 48% 52% 24% 24%; }
  35% { transform: scaleY(1.12) scaleX(0.94) translateY(-2%); border-radius: 52% 46% 22% 26%; }
  70% { transform: scaleY(0.94) scaleX(1.05) translateY(1%); border-radius: 45% 55% 26% 22%; }
  100% { transform: scaleY(1.08) scaleX(0.96) translateY(-1%); border-radius: 50% 48% 24% 24%; }
}
@keyframes maipaitv-hearth-glow {
  0% { opacity: 0.55; }
  50% { opacity: 0.85; }
  100% { opacity: 0.6; }
}
@keyframes maipaitv-ember {
  0% { transform: translateY(0) translateX(0); opacity: 0; }
  8% { opacity: 0.9; }
  60% { opacity: 0.6; }
  100% { transform: translateY(-58vh) translateX(2vw); opacity: 0; }
}
`

interface FlameSpec {
  className: string
  delay: string
  duration: string
  mix: number // how far toward warm-white the tip gradient goes
}

const FLAMES: FlameSpec[] = [
  { className: 'bottom-[4%] left-1/2 h-[34%] w-[26%] -translate-x-[85%] blur-xl', delay: '0s', duration: '3.4s', mix: 12 },
  { className: 'bottom-[4%] left-1/2 h-[42%] w-[30%] -translate-x-[15%] blur-xl', delay: '0.6s', duration: '2.9s', mix: 14 },
  { className: 'bottom-[3%] left-1/2 h-[52%] w-[24%] -translate-x-1/2 blur-lg', delay: '0.2s', duration: '2.4s', mix: 26 },
  { className: 'bottom-[3%] left-1/2 h-[38%] w-[16%] -translate-x-[110%] blur-lg', delay: '1.1s', duration: '2.7s', mix: 20 },
  { className: 'bottom-[3%] left-1/2 h-[36%] w-[15%] translate-x-[15%] blur-lg', delay: '0.8s', duration: '3.1s', mix: 22 },
  { className: 'bottom-[2%] left-1/2 h-[26%] w-[10%] -translate-x-1/2 blur-md', delay: '0.4s', duration: '1.9s', mix: 45 },
]

interface EmberSpec {
  className: string
  delay: string
  duration: string
}

const EMBERS: EmberSpec[] = [
  { className: 'left-[38%] size-1.5', delay: '0s', duration: '7s' },
  { className: 'left-[44%] size-1', delay: '2.2s', duration: '8.5s' },
  { className: 'left-[50%] size-2', delay: '1.1s', duration: '6.5s' },
  { className: 'left-[54%] size-1', delay: '3.6s', duration: '9s' },
  { className: 'left-[58%] size-1.5', delay: '0.7s', duration: '7.5s' },
  { className: 'left-[47%] size-1', delay: '5s', duration: '8s' },
  { className: 'left-[61%] size-1', delay: '4.2s', duration: '10s' },
  { className: 'left-[41%] size-1', delay: '6.1s', duration: '9.5s' },
]

function hearthStyle(channel: TvChannel): CSSProperties {
  return {
    backgroundImage: [
      `radial-gradient(70% 45% at 50% 102%, color-mix(in oklab, ${channel.colorDark} 55%, black) 0%, transparent 70%)`,
      'linear-gradient(180deg, black 0%, black 55%, color-mix(in oklab, black 92%, white) 100%)',
    ].join(', '),
  }
}

function flameStyle(channel: TvChannel, spec: FlameSpec): CSSProperties {
  return {
    backgroundImage: `linear-gradient(to top, color-mix(in oklab, ${channel.colorDark} 85%, black), ${channel.color} 55%, color-mix(in oklab, ${channel.color} ${100 - spec.mix}%, white))`,
    animation: `maipaitv-flame ${spec.duration} ease-in-out infinite alternate`,
    animationDelay: spec.delay,
    transformOrigin: 'bottom center',
  }
}

export function FiresideScreen({ channel, title, subtitle }: TvScreenProps) {
  return (
    <div data-theme="dark" className="relative h-full w-full overflow-hidden bg-black text-foreground">
      <style>{KEYFRAMES}</style>
      <div aria-hidden className="absolute inset-0" style={hearthStyle(channel)} />

      {/* Slow ambient glow over the whole hearth */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-3/5"
        style={{
          backgroundImage: `radial-gradient(55% 60% at 50% 100%, color-mix(in oklab, ${channel.color} 26%, transparent) 0%, transparent 70%)`,
          animation: 'maipaitv-hearth-glow 5s ease-in-out infinite',
        }}
      />

      {/* Flames */}
      {FLAMES.map((spec, i) => (
        <div key={i} aria-hidden className={cn('absolute', spec.className)} style={flameStyle(channel, spec)} />
      ))}

      {/* Embers */}
      {EMBERS.map((spec, i) => (
        <span
          key={i}
          aria-hidden
          className={cn('absolute bottom-[8%] rounded-full', spec.className)}
          style={{
            backgroundColor: channel.color,
            animation: `maipaitv-ember ${spec.duration} linear infinite`,
            animationDelay: spec.delay,
          }}
        />
      ))}

      {/* Hearth floor vignette */}
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-[6%] bg-gradient-to-t from-black to-transparent" />

      <div className="absolute inset-x-0 top-0 p-8 lg:p-10">
        <ScreenEyebrow channel={channel} title={title} subtitle={subtitle} />
      </div>
    </div>
  )
}
