import { useState } from 'react'
import { cn } from '@/lib/cn'

export interface MediaTab {
  key: string
  label: string
  /** Optional count shown next to the label, e.g. episode/review counts. */
  count?: number
  node: React.ReactNode
}

// Plex-style sub-navigation: a sticky tab bar with one active panel, so the long detail page
// becomes short, scannable views instead of an endless scroll. Falsy tabs are filtered out so
// callers can do `cond && { ... }`.
export function MediaTabs({
  tabs,
  initialKey,
  active: activeProp,
  onChange,
}: {
  tabs: (MediaTab | false | null | undefined)[]
  initialKey?: string
  /** Controlled mode: pass both to drive the active tab from outside (e.g. an action button). */
  active?: string
  onChange?: (key: string) => void
}) {
  const avail = tabs.filter((t): t is MediaTab => !!t)
  const [internal, setInternal] = useState(initialKey ?? avail[0]?.key)
  const active = activeProp ?? internal
  const setActive = onChange ?? setInternal
  const current = avail.find((t) => t.key === active) ?? avail[0]
  if (!avail.length) return null

  return (
    <div>
      <div className="glass-chrome sticky top-0 z-20 -mx-5 mb-6 border-b border-border/50 px-5">
        <div className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {avail.map((t) => {
            const on = current?.key === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActive(t.key)}
                className={cn(
                  'relative whitespace-nowrap px-3 py-3 text-sm font-medium transition-colors',
                  on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
                {t.count != null && t.count > 0 && (
                  <span className="ml-1.5 text-xs text-muted-foreground">{t.count}</span>
                )}
                {on && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" />}
              </button>
            )
          })}
        </div>
      </div>
      <div>{current?.node}</div>
    </div>
  )
}
