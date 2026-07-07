import { RectangleVertical, RectangleHorizontal, List } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'

// The toggle forces ONE uniform card size on every item regardless of source:
// 'big'  = tall TikTok-size cards (9:16) — even YouTube items render tall.
// 'grid' = wide YouTube-size cards (16:9) — even TikTok items render wide.
// 'list' = full-width rows.
export type CardListView = 'big' | 'grid' | 'list'

const OPTIONS = [
  ['big', RectangleVertical, 'Tall cards'],
  ['grid', RectangleHorizontal, 'Wide cards'],
  ['list', List, 'List view'],
] as const

/** Tall ⇄ wide ⇄ list card-size switch. Whichever is picked, every card is forced to that
 *  shape for a uniform grid. Pair with useViewPreference so the choice sticks. */
export function ViewToggle({ value, onChange, className }: {
  value: CardListView
  onChange: (v: CardListView) => void
  className?: string
}) {
  return (
    <div className={cn('flex gap-0.5 rounded-full border border-border p-0.5', className)}>
      {OPTIONS.map(([mode, Icon, label]) => (
        <Button
          key={mode}
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange(mode)}
          className={cn(value === mode ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
          aria-label={label}
          aria-pressed={value === mode}
        >
          <Icon className="size-4" />
        </Button>
      ))}
    </div>
  )
}
