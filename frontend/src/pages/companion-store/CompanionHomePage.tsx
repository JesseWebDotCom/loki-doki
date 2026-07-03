import { Bot } from 'lucide-react'
import { cn } from '@/lib/cn'
import { cardVariants } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { useCompanionStore } from '@/lib/companions/useCompanionStore'
import { COMPANION_CATEGORIES } from '@/lib/companions/companionCategories'
import { CompanionFeaturedHero } from '@/components/companions/store/CompanionFeaturedHero'
import { CompanionCategoryPill } from '@/components/companions/store/CompanionCategoryPill'
import { CompanionCard, CompanionMiniCard } from '@/components/companions/store/CompanionCard'
import { CardGridSkeleton } from '@/components/store/SectionHead'

export function CompanionHomePage() {
  const { companions, isLoading, activeCompanionId } = useCompanionStore()

  // Recommended: the not-yet-active first, then the rest.
  const recommended = [...companions].sort((a, b) => Number(a.id === activeCompanionId) - Number(b.id === activeCompanionId)).slice(0, 10)

  return (
    <PageContainer className="space-y-10 py-6 pb-20">
      {!isLoading && <CompanionFeaturedHero companions={companions} />}

      <section>
        <SectionHeader title="Categories" to="/companions/categories" className="mb-4" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {COMPANION_CATEGORIES.map((c) => <CompanionCategoryPill key={c.key} category={c} />)}
        </div>
      </section>

      {!isLoading && companions.length === 0 ? (
        <div className={cn(cardVariants({ variant: 'dashed' }), 'flex flex-col items-center justify-center gap-3 py-16 text-center')}>
          <Bot className="size-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No companions yet. An admin can create them in Admin → Companions.</p>
        </div>
      ) : (
        <>
          <section>
            <SectionHeader title="Recommended for you" to="/companions/browse" className="mb-4" />
            {isLoading ? (
              <div className="flex gap-4 overflow-hidden">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-32 w-56 shrink-0 rounded-card" />)}
              </div>
            ) : (
              <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                {recommended.map((c) => <CompanionMiniCard key={c.id} c={c} />)}
              </div>
            )}
          </section>

          <section>
            <SectionHeader title="All companions" count={isLoading ? undefined : companions.length} to="/companions/browse" className="mb-4" />
            {isLoading ? (
              <CardGridSkeleton />
            ) : (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
                {companions.map((c) => <CompanionCard key={c.id} c={c} />)}
              </div>
            )}
          </section>
        </>
      )}
    </PageContainer>
  )
}
