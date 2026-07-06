import { LayoutGrid, List } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'

export type CardListView = 'grid' | 'list'

/** Card ⇄ list view switch. Pair with a persisted preference (see useViewPreference)
 *  so the choice sticks across visits and devices. */
export function ViewToggle({ value, onChange, className }: {
  value: CardListView
  onChange: (v: CardListView) => void
  className?: string
}) {
  return (
    <div className={cn('flex gap-0.5 rounded-full border border-border p-0.5', className)}>
      {([['grid', LayoutGrid], ['list', List]] as const).map(([mode, Icon]) => (
        <Button
          key={mode}
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange(mode)}
          className={cn(value === mode ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
          aria-label={mode === 'grid' ? 'Card view' : 'List view'}
          aria-pressed={value === mode}
        >
          <Icon className="size-4" />
        </Button>
      ))}
    </div>
  )
}
