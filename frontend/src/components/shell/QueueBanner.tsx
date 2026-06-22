import { Clock, X } from 'lucide-react'
import { useState } from 'react'
import { useChatContext } from '@/context/ChatContext'

/**
 * QueueBanner — shown when the user's generation is waiting for a concurrency slot.
 * Reads queuePosition from ChatContext; only renders when position > 0.
 * Dismissable per session (re-appears if position changes).
 */
export function QueueBanner() {
  const { queuePosition } = useChatContext()
  const [dismissed, setDismissed] = useState(false)

  // Re-show if position changes (new generation queued)
  const shouldShow = typeof queuePosition === 'number' && queuePosition > 0

  if (!shouldShow || dismissed) return null

  const posLabel = queuePosition === 1
    ? 'You\'re next in line'
    : `You\'re #${queuePosition} in line`

  return (
    <div className="shrink-0 flex items-center gap-3 border-b border-border/40 bg-amber-500/8 px-4 py-2">
      <Clock className="size-3.5 text-amber-600 dark:text-amber-400 shrink-0 animate-pulse" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-amber-700 dark:text-amber-300">
          <span className="font-medium">{posLabel}</span>
          {' — '}
          the system is finishing another generation first. Hang tight.
        </p>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
        aria-label="Dismiss queue notification"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
