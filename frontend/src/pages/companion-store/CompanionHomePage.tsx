import { Bot } from 'lucide-react'
import { useCompanionStore } from '@/lib/companions/useCompanionStore'
import { COMPANION_CATEGORIES } from '@/lib/companions/companionCategories'
import { CompanionFeaturedHero } from '@/components/companions/store/CompanionFeaturedHero'
import { CompanionCategoryPill } from '@/components/companions/store/CompanionCategoryPill'
import { CompanionCard, CompanionMiniCard } from '@/components/companions/store/CompanionCard'
import { SectionHead, CardGridSkeleton } from '@/components/store/SectionHead'

export function CompanionHomePage() {
  const { companions, isLoading, activeCompanionId } = useCompanionStore()

  // Recommended: the not-yet-active first, then the rest.
  const recommended = [...companions].sort((a, b) => Number(a.id === activeCompanionId) - Number(b.id === activeCompanionId)).slice(0, 10)

  return (
    <div className="mx-auto max-w-6xl space-y-10 px-5 py-6 pb-20">
      {!isLoading && <CompanionFeaturedHero companions={companions} />}

      <section>
        <SectionHead title="Categories" viewAllTo="/companions/categories" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {COMPANION_CATEGORIES.map((c) => <CompanionCategoryPill key={c.key} category={c} />)}
        </div>
      </section>

      {!isLoading && companions.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-16 text-center">
          <Bot className="size-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No companions yet. An admin can create them in Admin → Companions.</p>
        </div>
      ) : (
        <>
          <section>
            <SectionHead title="Recommended for you" viewAllTo="/companions/browse" />
            {isLoading ? (
              <div className="flex gap-4 overflow-hidden">
                {Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-32 w-56 shrink-0 animate-pulse rounded-2xl bg-card/40" />)}
              </div>
            ) : (
              <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
                {recommended.map((c) => <CompanionMiniCard key={c.id} c={c} />)}
              </div>
            )}
          </section>

          <section>
            <SectionHead title="All companions" viewAllTo="/companions/browse" />
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
    </div>
  )
}
