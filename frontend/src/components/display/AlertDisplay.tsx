// AlertDisplay — ephemeral full-screen alert overlay for screen Pods.
// Rendered on top of whatever the current view is when presence.alert is set.
// Pulsates to draw attention; shows a countdown pill; auto-fades as it expires.

import { useEffect, useState } from 'react'
import type { Alert } from '@/lib/presence'

interface Props {
  alert: Alert
  onExpired: () => void
}

export function AlertDisplay({ alert, onExpired }: Props) {
  const [remaining, setRemaining] = useState(Math.max(0, alert.expiresAt - Date.now()))

  useEffect(() => {
    const t = setInterval(() => {
      const r = Math.max(0, alert.expiresAt - Date.now())
      setRemaining(r)
      if (r === 0) {
        clearInterval(t)
        onExpired()
      }
    }, 250)
    return () => clearInterval(t)
  }, [alert.expiresAt, onExpired])

  const totalSec = Math.round((alert.expiresAt - (alert.expiresAt - remaining) - 0) / 1000)
  const remSec = Math.ceil(remaining / 1000)
  const progress = remaining > 0 ? remaining / (totalSec > 0 ? totalSec * 1000 : 30_000) : 0
  const fading = remaining < 5_000

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center gap-8 select-none"
      style={{
        backgroundColor: alert.color,
        opacity: fading ? Math.max(0.2, remaining / 5_000) : 1,
        transition: 'opacity 0.5s',
      }}
    >
      {/* Pulsing emoji icon */}
      <div
        className="text-[9rem] leading-none drop-shadow-2xl"
        style={{ animation: 'pod-alert-pulse 1s ease-in-out infinite' }}
      >
        {alert.emoji}
      </div>

      {/* Message */}
      <div className="text-white font-bold text-5xl text-center px-12 drop-shadow-lg leading-tight">
        {alert.message}
      </div>

      {/* Countdown bar */}
      <div className="w-64 flex flex-col items-center gap-2 mt-4">
        <div className="w-full h-2 bg-white/30 rounded-full overflow-hidden">
          <div
            className="h-full bg-white rounded-full transition-all duration-250"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <span className="text-white/60 text-xl font-mono">{remSec}s</span>
      </div>

      <style>{`
        @keyframes pod-alert-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.08); }
        }
      `}</style>
    </div>
  )
}
