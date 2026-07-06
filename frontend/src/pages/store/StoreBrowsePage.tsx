import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LayoutGrid, List, Search, ShoppingBag } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { useStoreApps } from '@/lib/store/useStoreApps'
import { StoreAppCard } from '@/components/store/StoreAppCard'
import { StoreAppRow } from '@/components/store/StoreAppRow'
import { CardGridSkeleton } from '@/components/store/SectionHead'
import { STORE_GRADIENT } from '@/components/store/StoreRail'

export function StoreBrowsePage() {
  const { apps, isLoading } = useStoreApps()
  const [params] = useSearchParams()
  const q = (params.get('q') ?? '').trim().toLowerCase()
  const [view, setView] = useState<'grid' | 'list'>('grid')

  const filtered = q
    ? apps.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        (a.keywords ?? []).some(k => k.includes(q)),
      )
    : apps

  return (
    <PageContainer className="pb-20">
      <PageHeader
        title={q ? 'Search' : 'Browse'}
        eyebrow="App Store"
        icon={ShoppingBag}
        gradient={STORE_GRADIENT}
        subtitle={q ? `${filtered.length} result${filtered.length === 1 ? '' : 's'} for "${params.get('q')}"` : `${apps.length} apps`}
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
          <p className="text-sm text-muted-foreground/60">No results found.</p>
        </div>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {filtered.map(app => <StoreAppCard key={app.id} app={app} />)}
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map(app => <StoreAppRow key={app.id} app={app} />)}
        </div>
      )}
    </PageContainer>
  )
}
