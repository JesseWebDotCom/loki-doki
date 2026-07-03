import { Link, useParams } from 'react-router-dom'
import { ChevronRight, ShieldAlert } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { useCompanionStore, isLocked } from '@/lib/companions/useCompanionStore'
import { getCompanionCategory } from '@/lib/companions/companionCategories'
import { CompanionCard } from '@/components/companions/store/CompanionCard'
import { CardGridSkeleton } from '@/components/store/SectionHead'

export function CompanionCategoryPage() {
  const { key = '' } = useParams()
  const { companions, isLoading } = useCompanionStore()

  const category = getCompanionCategory(key)
  const inCategory = companions.filter((c) => c.category === key)
  const lockedCount = inCategory.filter(isLocked).length

  if (!category) {
    return (
      <div className="px-5 py-20 text-center text-sm text-muted-foreground">
        Category not found. <Link to="/companions/categories" className="text-brand hover:underline">All categories</Link>
      </div>
    )
  }

  return (
    <PageContainer className="py-6 pb-20">
      <nav className="mb-4 flex items-center gap-1.5 text-sm">
        <Link to="/companions/categories" className="text-muted-foreground hover:text-foreground">Categories</Link>
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
        subtitle={`${category.blurb} ${inCategory.length} ${inCategory.length === 1 ? 'companion' : 'companions'}${lockedCount > 0 ? ` · ${lockedCount} locked` : ''}.`}
        className="mb-8"
      />

      {category.mature && (
        <div className="mb-6 flex items-start gap-2.5 rounded-card border border-warning/30 bg-warning/10 px-4 py-3 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>These companions carry mature content. Any shown locked exceed your current content settings. Raise them in Settings to unlock.</p>
        </div>
      )}

      {isLoading ? (
        <CardGridSkeleton />
      ) : inCategory.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground/60">No companions in this category yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {inCategory.map((c) => <CompanionCard key={c.id} c={c} />)}
        </div>
      )}
    </PageContainer>
  )
}
