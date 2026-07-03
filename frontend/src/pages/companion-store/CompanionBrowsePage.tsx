import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LayoutGrid, List, Search } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
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
    <PageContainer className="pb-20">
      <PageHeader
        title={q ? 'Search' : 'Browse'}
        eyebrow="Companions"
        subtitle={q ? `${filtered.length} result${filtered.length === 1 ? '' : 's'} for "${params.get('q')}"` : `${companions.length} companions`}
        actions={
          <div className="flex gap-0.5 rounded-full border border-border p-0.5">
            {([['grid', LayoutGrid], ['list', List]] as const).map(([mode, Icon]) => (
              <Button
                key={mode}
                variant="ghost"
                size="icon-sm"
                onClick={() => setView(mode)}
                className={cn(view === mode ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
                aria-label={mode}
              >
                <Icon className="size-4" />
              </Button>
            ))}
          </div>
        }
      />

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
        <div className="space-y-1">
          {filtered.map((c) => <CompanionRow key={c.id} c={c} />)}
        </div>
      )}
    </PageContainer>
  )
}
