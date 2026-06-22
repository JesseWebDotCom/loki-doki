import { useStoreApps, STORE_CATEGORIES, categoryCounts } from '@/lib/store/useStoreApps'
import { CategoryCard } from '@/components/store/CategoryPill'

export function StoreCategoriesPage() {
  const { apps } = useStoreApps()
  const counts = categoryCounts(apps)

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-6 pb-20">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Categories</h1>
        <p className="text-sm text-muted-foreground">Browse apps and extensions by category.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {STORE_CATEGORIES.map(c => (
          <CategoryCard key={c.key} category={c} count={counts[c.key] ?? 0} />
        ))}
      </div>
    </div>
  )
}
