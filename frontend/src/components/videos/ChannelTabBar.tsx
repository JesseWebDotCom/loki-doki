import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** The shared channel-page tab bar: an underline-style tab row with an optional right slot
 *  (used for the grid/list ViewToggle). Shared by the YouTube channel page and the non-YouTube
 *  source creator pages so every subscription page's tabs look identical. */
export function ChannelTabBar<T extends string>({ tabs, active, onChange, right }: {
  tabs: Array<[T, string]>
  active: T
  onChange: (tab: T) => void
  right?: ReactNode
}) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4 border-b border-border/60">
      <div className="flex min-w-0 gap-6 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map(([key, label]) => (
          <button key={key} onClick={() => onChange(key)}
            className={cn('relative -mb-px shrink-0 border-b-2 px-1 pb-3 text-sm font-semibold transition-colors',
              active === key ? 'border-[var(--yt-accent)] text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
          </button>
        ))}
      </div>
      {right}
    </div>
  )
}
