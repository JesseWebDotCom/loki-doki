import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LayoutGrid, List, Search } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useStoreApps } from '@/lib/store/useStoreApps'
import { StoreAppCard } from '@/components/store/StoreAppCard'
import { StoreAppRow } from '@/components/store/StoreAppRow'
import { CardGridSkeleton } from '@/components/store/SectionHead'

export function StoreBrowsePage() {
  const { apps, isLoading } = useStoreApps()
  const [params] = useSearchParams()
  const q = (params.get('q') ?? '').trim().toLowerCase()
  const [view, setView] = useState<'grid' | 'list'>('grid')

  const filtered = q
    ? apps.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q),
      )
    : apps

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-5 py-6 pb-20">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight">{q ? 'Search' : 'Browse'}</h1>
          <p className="text-sm text-muted-foreground">
            {q ? `${filtered.length} result${filtered.length === 1 ? '' : 's'} for "${params.get('q')}"` : `${apps.length} apps and extensions`}
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border/40 p-0.5">
          {([['grid', LayoutGrid], ['list', List]] as const).map(([mode, Icon]) => (
            <button
              key={mode}
              onClick={() => setView(mode)}
              className={cn(
                'flex size-7 items-center justify-center rounded-md transition-colors',
                view === mode ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
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
    </div>
  )
}
