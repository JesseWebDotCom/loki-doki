import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { useCompanionStore, companionCategoryCounts } from '@/lib/companions/useCompanionStore'
import { COMPANION_CATEGORIES } from '@/lib/companions/companionCategories'
import { CompanionCategoryCard } from '@/components/companions/store/CompanionCategoryPill'

export function CompanionCategoriesPage() {
  const { companions } = useCompanionStore()
  const counts = companionCategoryCounts(companions)

  return (
    <PageContainer className="pb-20">
      <PageHeader
        title="Categories"
        eyebrow="Companions"
        subtitle="Browse companions by what they're best at."
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {COMPANION_CATEGORIES.map((c) => (
          <CompanionCategoryCard key={c.key} category={c} count={counts[c.key] ?? 0} />
        ))}
      </div>
    </PageContainer>
  )
}
