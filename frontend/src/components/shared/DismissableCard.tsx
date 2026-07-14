// Wraps a suggestion card with a "Not interested" X button: hover-revealed on pointer
// devices, always visible on touch. Wraps rather than modifies the card component so
// every rail (videos, shows, podcasts...) reuses the same affordance without threading
// props through each card's internals.

import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export function DismissableCard({ onDismiss, children }: { onDismiss: () => void; children: ReactNode }) {
  return (
    <div className="group/dismiss relative">
      {children}
      <button
        type="button"
        aria-label="Not interested"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDismiss() }}
        className="absolute right-1.5 top-1.5 z-10 rounded-full bg-black/60 p-1.5 text-white opacity-0 transition-opacity hover:bg-black/80 focus-visible:opacity-100 group-hover/dismiss:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
