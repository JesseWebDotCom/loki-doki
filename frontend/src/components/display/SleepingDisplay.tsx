// SleepingDisplay — dim/near-black screen for the Pod 'sleeping' view.
// Shows a minimal clock and a moon icon at very low brightness.
// The actual ambient sound (rain, white noise) is played via Wyoming on the hardware
// Pod speaker — this component just renders the visual.

import { useEffect, useState } from 'react'
import type { UserPresence } from '@/lib/presence'

interface Props {
  presence: UserPresence | null
}

export function SleepingDisplay({ presence }: Props) {
  const sleep = presence?.sleep ?? null
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 30_000) // update every 30s (saves render cycles)
    return () => clearInterval(t)
  }, [])

  // dimBrightness: 0 = pitch black, 0.05 = barely visible dim clock.
  const brightness = sleep?.dimBrightness ?? 0.05
  const opacity = Math.max(0.04, Math.min(1, brightness))

  const hours = time.getHours()
  const minutes = time.getMinutes()
  const h12 = hours % 12 || 12
  const ampm = hours < 12 ? 'AM' : 'PM'

  return (
    <div className="fixed inset-0 bg-black select-none flex flex-col items-center justify-center gap-6">
      {/* Moon icon */}
      <div style={{ opacity }} className="text-[6rem] leading-none transition-opacity duration-2000">
        🌙
      </div>

      {/* Dim clock */}
      <div
        style={{ opacity }}
        className="text-white font-thin text-[7rem] leading-none tracking-widest transition-opacity duration-2000"
      >
        {h12}:{String(minutes).padStart(2, '0')}
        <span className="text-[3rem] ml-3">{ampm}</span>
      </div>

      {/* Ambient sound label (barely visible) */}
      {sleep?.ambientSound && (
        <div style={{ opacity: opacity * 0.6 }} className="text-white/60 text-xl tracking-widest uppercase mt-2">
          {{ rain: '🌧 Rain', white_noise: '〜 White Noise', ocean: '🌊 Ocean', fan: '💨 Fan' }[sleep.ambientSound] ?? sleep.ambientSound}
        </div>
      )}
    </div>
  )
}
