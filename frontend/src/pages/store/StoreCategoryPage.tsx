import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { SkeletonListRows } from '@/components/shared/SkeletonBlocks'
import { useStoreApps, STORE_CATEGORIES } from '@/lib/store/useStoreApps'
import { FeaturedCard } from '@/components/store/FeaturedCard'
import { StoreAppRow } from '@/components/store/StoreAppRow'
import { FilterPanel, DEFAULT_FILTERS, applyFilters, type SortMode } from '@/components/store/FilterPanel'

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

  return (
    <PageContainer className="py-6 pb-20">
      {/* Breadcrumb */}
      <nav className="mb-4 flex items-center gap-1.5 text-sm">
        <Link to="/app-store/categories" className="text-muted-foreground hover:text-foreground">Categories</Link>
        <ChevronRight className="size-3.5 text-muted-foreground/50" />
        <span className="font-medium text-foreground">{category.name}</span>
      </nav>

      {/* Editorial hero: bg-card panel with the category gradient as atmosphere. */}
      <PageHeader
        hero
        eyebrow="Category"
        title={category.name}
        icon={category.icon}
        gradient={category.gradient}
        subtitle={`${inCategory.length} ${inCategory.length === 1 ? 'app' : 'apps'} in this category · ${installedCount} installed · Updated today`}
        className="mb-8"
      />

      <div className="flex gap-8">
        {/* Main column */}
        <div className="min-w-0 flex-1 space-y-8">
          {featured.length > 0 && (
            <section>
              <SectionHeader title="Featured" className="mb-4" />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {featured.map(app => <FeaturedCard key={app.id} app={app} />)}
              </div>
            </section>
          )}

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-section">All apps</h2>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Sort by:
                <select
                  value={filters.sort}
                  onChange={e => setFilters({ ...filters, sort: e.target.value as SortMode })}
                  className="rounded-control border border-border bg-muted/40 px-2 py-1 text-xs font-medium text-foreground outline-none"
                >
                  {(Object.keys(SORT_LABELS) as SortMode[]).map(s => (
                    <option key={s} value={s}>{SORT_LABELS[s]}</option>
                  ))}
                </select>
              </label>
            </div>

            {isLoading ? (
              <SkeletonListRows count={5} />
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
    </PageContainer>
  )
}
