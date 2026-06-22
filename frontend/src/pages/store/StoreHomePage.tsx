import { FeaturedHero } from '@/components/store/FeaturedHero'
import { CategoryPill } from '@/components/store/CategoryPill'
import { StoreAppCard, StoreAppMiniCard } from '@/components/store/StoreAppCard'
import { SectionHead, CardGridSkeleton } from '@/components/store/SectionHead'
import { useStoreApps, STORE_CATEGORIES } from '@/lib/store/useStoreApps'

export function StoreHomePage() {
  const { apps, isLoading } = useStoreApps()

  // Recommended: not-yet-installed first, then the rest.
  const recommended = [...apps].sort((a, b) => Number(a.enabled) - Number(b.enabled)).slice(0, 10)

  return (
    <div className="mx-auto max-w-6xl space-y-10 px-5 py-6 pb-20">
      {!isLoading && <FeaturedHero apps={apps} />}

      <section>
        <SectionHead title="Categories" viewAllTo="/app-store/categories" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {STORE_CATEGORIES.map(c => <CategoryPill key={c.key} category={c} />)}
        </div>
      </section>

      <section>
        <SectionHead title="Recommended for you" viewAllTo="/app-store/browse" />
        {isLoading ? (
          <div className="flex gap-4 overflow-hidden">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-32 w-56 shrink-0 animate-pulse rounded-2xl bg-card/40" />
            ))}
          </div>
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
            {recommended.map(app => <StoreAppMiniCard key={app.id} app={app} />)}
          </div>
        )}
      </section>

      <section>
        <SectionHead title="All apps" viewAllTo="/app-store/browse" />
        {isLoading ? (
          <CardGridSkeleton />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
            {apps.map(app => <StoreAppCard key={app.id} app={app} />)}
          </div>
        )}
      </section>
    </div>
  )
}
