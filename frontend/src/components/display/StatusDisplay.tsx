// StatusDisplay — full-frame color flood + label for the Pod status view (BUSY-Bar style).
// Shown when a device is in 'status' mode. Reads the user's current status from the
// UserPresence object polled by DisplayPage. If no status is set, shows a gentle
// "Available" default so the display is never blank.

import { useEffect, useState } from 'react'
import type { UserPresence } from '@/lib/presence'

interface Props {
  presence: UserPresence | null
}

const STATUS_ICONS: Record<string, string> = {
  available: '✓',
  busy: '✕',
  dnd: '🔕',
  on_call: '📞',
  in_meeting: '🗓',
  focusing: '🎯',
  brb: '↩',
  away: '💤',
  custom: '●',
}

export function StatusDisplay({ presence }: Props) {
  const status = presence?.status ?? null
  const [now, setNow] = useState(Date.now())

  // Tick every second to update the countdown timer.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const color = status?.color ?? '#22c55e'
  const label = status?.label ?? 'Available'
  const icon = STATUS_ICONS[status?.state ?? 'available'] ?? '●'
  const timerEndsAt = status?.timerEndsAt ?? null
  const remainingMs = timerEndsAt ? Math.max(0, timerEndsAt - now) : null
  const remainingSec = remainingMs != null ? Math.floor(remainingMs / 1000) : null

  const formatRemaining = (sec: number) => {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${m}:${String(s).padStart(2, '0')}`
  }

  // Color intensity: full when > 5 min remaining, shifts to amber when < 5 min, red-pulse when < 1 min.
  const isExpiringSoon = remainingSec != null && remainingSec < 300
  const isExpiringSoonest = remainingSec != null && remainingSec < 60

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center select-none transition-colors duration-1000"
      style={{ backgroundColor: color }}
    >
      {/* Pulse ring for nearly-expired timers */}
      {isExpiringSoonest && (
        <div
          className="absolute inset-0 animate-ping opacity-20 rounded-none"
          style={{ backgroundColor: '#fff' }}
        />
      )}

      {/* Icon */}
      <div
        className="text-[8rem] leading-none mb-6 opacity-90 drop-shadow-lg"
        style={{ filter: 'drop-shadow(0 4px 24px rgba(0,0,0,0.4))' }}
      >
        {icon}
      </div>

      {/* Label. design-ok(font-black): full-frame BUSY-Bar-style status flood, read from
          across a room, not a generic UI heading; keeps the bespoke oversized weight. */}
      <div
        className="text-white font-black text-[5.5rem] leading-none tracking-tight text-center px-8 drop-shadow-xl"
        style={{ textShadow: '0 4px 32px rgba(0,0,0,0.5)' }}
      >
        {label}
      </div>

      {/* Countdown timer */}
      {remainingSec != null && remainingSec > 0 && (
        <div
          className={`mt-10 text-white/80 font-mono text-[3rem] leading-none tracking-widest ${isExpiringSoon ? 'text-white' : ''}`}
          style={{ textShadow: '0 2px 12px rgba(0,0,0,0.4)' }}
        >
          {formatRemaining(remainingSec)}
        </div>
      )}

      {/* Subtle set-time footer */}
      {status?.setAt && !remainingSec && (
        <div className="absolute bottom-8 text-white/40 text-2xl tracking-wide">
          {new Date(status.setAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  )
}
