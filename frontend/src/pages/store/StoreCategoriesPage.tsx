import { ShoppingBag } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { useStoreApps, STORE_CATEGORIES, categoryCounts } from '@/lib/store/useStoreApps'
import { CategoryCard } from '@/components/store/CategoryPill'
import { STORE_GRADIENT } from '@/components/store/StoreRail'

export function StoreCategoriesPage() {
  const { apps } = useStoreApps()
  const counts = categoryCounts(apps)

  return (
    <PageContainer className="pb-20">
      <PageHeader
        title="Categories"
        eyebrow="App Store"
        icon={ShoppingBag}
        gradient={STORE_GRADIENT}
        subtitle="Browse apps and extensions by category."
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {STORE_CATEGORIES.map(c => (
          <CategoryCard key={c.key} category={c} count={counts[c.key] ?? 0} />
        ))}
      </div>
    </PageContainer>
  )
}
