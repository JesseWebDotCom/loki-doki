import { useCompanionStore, companionCategoryCounts } from '@/lib/companions/useCompanionStore'
import { COMPANION_CATEGORIES } from '@/lib/companions/companionCategories'
import { CompanionCategoryCard } from '@/components/companions/store/CompanionCategoryPill'

export function CompanionCategoriesPage() {
  const { companions } = useCompanionStore()
  const counts = companionCategoryCounts(companions)

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-6 pb-20">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Categories</h1>
        <p className="text-sm text-muted-foreground">Browse companions by what they're best at.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {COMPANION_CATEGORIES.map((c) => (
          <CompanionCategoryCard key={c.key} category={c} count={counts[c.key] ?? 0} />
        ))}
      </div>
    </div>
  )
}
