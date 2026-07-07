import { Grid2x2, Grid3x3, List } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'

// 'big'  = large, tall (9:16) cards (a TikTok-style feed); landscape sources show their
//          16:9 thumb with the extra space used for more info.
// 'grid' = the regular uniform 16:9 grid (same size as YouTube).
// 'list' = full-width rows.
export type CardListView = 'big' | 'grid' | 'list'

const OPTIONS = [
  ['big', Grid2x2, 'Large view'],
  ['grid', Grid3x3, 'Grid view'],
  ['list', List, 'List view'],
] as const

/** Large ⇄ grid ⇄ list view switch. Pair with a persisted preference (see
 *  useViewPreference) so the choice sticks across visits and devices. */
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
