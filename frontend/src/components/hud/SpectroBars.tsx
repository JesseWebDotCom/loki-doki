import { cn } from '@/lib/cn'

// Tiny animated spectrogram for the island's now-playing wing chip, matching
// SuperIsland's compact media indicator. Pure CSS (island-eq keyframes in
// index.css, with a reduced-motion opt-out); freezes when paused.

const DELAYS = ['0ms', '160ms', '320ms', '80ms']

export function SpectroBars({ playing, className }: { playing: boolean; className?: string }) {
  return (
    <div className={cn('flex h-3.5 items-end gap-[2px]', className)} aria-hidden>
      {DELAYS.map((delay, i) => (
        <span
          key={i}
          className={cn('w-[2.5px] rounded-full bg-success', playing && 'island-eq-bar')}
          style={{ height: '100%', animationDelay: delay, transform: playing ? undefined : 'scaleY(0.35)', transformOrigin: 'bottom' }}
        />
      ))}
    </div>
  )
}
