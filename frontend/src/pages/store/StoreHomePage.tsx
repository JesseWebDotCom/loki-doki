import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Skeleton } from '@/components/ui/skeleton'
import { FeaturedHero } from '@/components/store/FeaturedHero'
import { CategoryCard } from '@/components/store/CategoryPill'
import { StoreAppCard, StoreAppMiniCard } from '@/components/store/StoreAppCard'
import { CardGridSkeleton } from '@/components/store/SectionHead'
import { useStoreApps, STORE_CATEGORIES, categoryCounts } from '@/lib/store/useStoreApps'

export function StoreHomePage() {
  const { apps, isLoading } = useStoreApps()

  // Recommended: not-yet-installed first, then the rest.
  const recommended = [...apps].sort((a, b) => Number(a.enabled) - Number(b.enabled)).slice(0, 10)
  const counts = categoryCounts(apps)

  return (
    <PageContainer className="space-y-10 py-6 pb-20">
      {!isLoading && <FeaturedHero apps={apps} />}

      <section>
        <SectionHeader title="Categories" to="/app-store/categories" className="mb-4" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {STORE_CATEGORIES.map(c => <CategoryCard key={c.key} category={c} count={counts[c.key] ?? 0} />)}
        </div>
      </section>

      <section>
        <SectionHeader title="Recommended for you" to="/app-store/browse" className="mb-4" />
        {isLoading ? (
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-56 shrink-0 rounded-card" />
            ))}
          </div>
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
            {recommended.map(app => <StoreAppMiniCard key={app.id} app={app} />)}
          </div>
        )}
      </section>

      <section>
        <SectionHeader title="All apps" count={isLoading ? undefined : apps.length} to="/app-store/browse" className="mb-4" />
        {isLoading ? (
          <CardGridSkeleton />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
            {apps.map(app => <StoreAppCard key={app.id} app={app} />)}
          </div>
        )}
      </section>
    </PageContainer>
  )
}
