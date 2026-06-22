import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LayoutGrid, List, Search } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useCompanionStore } from '@/lib/companions/useCompanionStore'
import { getCompanionCategory } from '@/lib/companions/companionCategories'
import { CompanionCard, CompanionRow } from '@/components/companions/store/CompanionCard'
import { CardGridSkeleton } from '@/components/store/SectionHead'

export function CompanionBrowsePage() {
  const { companions, isLoading } = useCompanionStore()
  const [params] = useSearchParams()
  const q = (params.get('q') ?? '').trim().toLowerCase()
  const [view, setView] = useState<'grid' | 'list'>('grid')

  const filtered = q
    ? companions.filter((c) =>
        c.name.toLowerCase().includes(q) ||
        (c.backstory ?? '').toLowerCase().includes(q) ||
        (getCompanionCategory(c.category)?.name ?? '').toLowerCase().includes(q),
      )
    : companions

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-5 py-6 pb-20">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight">{q ? 'Search' : 'Browse'}</h1>
          <p className="text-sm text-muted-foreground">
            {q ? `${filtered.length} result${filtered.length === 1 ? '' : 's'} for "${params.get('q')}"` : `${companions.length} companions`}
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border/40 p-0.5">
          {([['grid', LayoutGrid], ['list', List]] as const).map(([mode, Icon]) => (
            <button
              key={mode}
              onClick={() => setView(mode)}
              className={cn('flex size-7 items-center justify-center rounded-md transition-colors', view === mode ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
              aria-label={mode}
            >
              <Icon className="size-4" />
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <CardGridSkeleton />
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-24 text-center">
          <Search className="size-8 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground/60">No companions found.</p>
        </div>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {filtered.map((c) => <CompanionCard key={c.id} c={c} />)}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => <CompanionRow key={c.id} c={c} />)}
        </div>
      )}
    </div>
  )
}
