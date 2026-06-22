import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useStoreApps, STORE_CATEGORIES } from '@/lib/store/useStoreApps'
import { FeaturedCard } from '@/components/store/FeaturedCard'
import { StoreAppRow } from '@/components/store/StoreAppRow'
import { FilterPanel, DEFAULT_FILTERS, applyFilters, type SortMode } from '@/components/store/FilterPanel'
import { SectionHead } from '@/components/store/SectionHead'

const SORT_LABELS: Record<SortMode, string> = {
  relevance: 'Relevance',
  name: 'Name (A–Z)',
  installed: 'Installed first',
}

export function StoreCategoryPage() {
  const { key = '' } = useParams()
  const { apps, isLoading } = useStoreApps()
  const [filters, setFilters] = useState(DEFAULT_FILTERS)

  const category = STORE_CATEGORIES.find(c => c.key === key)
  const inCategory = apps.filter(a => a.categoryKey === key)
  const featured = inCategory.slice(0, 3)
  const list = applyFilters(inCategory, filters)
  const installedCount = inCategory.filter(a => a.enabled).length

  if (!category) {
    return (
      <div className="px-5 py-20 text-center text-sm text-muted-foreground">
        Category not found. <Link to="/app-store/categories" className="text-brand hover:underline">All categories</Link>
      </div>
    )
  }

  const Icon = category.icon

  return (
    <div className="mx-auto max-w-6xl px-5 py-6 pb-20">
      {/* Breadcrumb */}
      <nav className="mb-4 flex items-center gap-1.5 text-sm">
        <Link to="/app-store/categories" className="text-muted-foreground hover:text-foreground">Categories</Link>
        <ChevronRight className="size-3.5 text-muted-foreground/50" />
        <span className="font-medium text-foreground">{category.name}</span>
      </nav>

      {/* Hero header */}
      <div
        className="relative mb-8 overflow-hidden rounded-3xl p-8 text-white shadow-lg"
        style={{ backgroundImage: category.gradient }}
      >
        <div className="absolute inset-0 bg-gradient-to-r from-black/45 to-transparent" />
        <Icon className="pointer-events-none absolute -right-4 top-1/2 size-52 -translate-y-1/2 text-white/10" />
        <div className="relative max-w-lg">
          <h1 className="text-4xl font-black tracking-tight drop-shadow">{category.name}</h1>
          <p className="mt-2 text-sm text-white/85">
            {inCategory.length} {inCategory.length === 1 ? 'app' : 'apps'} in this category.
          </p>
          <p className="mt-4 text-xs font-medium text-white/70">
            {installedCount} installed · Updated today
          </p>
        </div>
      </div>

      <div className="flex gap-8">
        {/* Main column */}
        <div className="min-w-0 flex-1 space-y-8">
          {featured.length > 0 && (
            <section>
              <SectionHead title="Featured" />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {featured.map(app => <FeaturedCard key={app.id} app={app} />)}
              </div>
            </section>
          )}

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-bold tracking-tight">All apps</h2>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Sort by:
                <select
                  value={filters.sort}
                  onChange={e => setFilters({ ...filters, sort: e.target.value as SortMode })}
                  className="rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs font-medium text-foreground outline-none"
                >
                  {(Object.keys(SORT_LABELS) as SortMode[]).map(s => (
                    <option key={s} value={s}>{SORT_LABELS[s]}</option>
                  ))}
                </select>
              </label>
            </div>

            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="h-16 animate-pulse rounded-2xl bg-card/40" />
                ))}
              </div>
            ) : list.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground/60">No apps match these filters.</p>
            ) : (
              <div className="space-y-1">
                {list.map(app => <StoreAppRow key={app.id} app={app} />)}
              </div>
            )}
          </section>
        </div>

        {/* Filters */}
        <FilterPanel filters={filters} onChange={setFilters} className="hidden lg:block" />
      </div>
    </div>
  )
}
