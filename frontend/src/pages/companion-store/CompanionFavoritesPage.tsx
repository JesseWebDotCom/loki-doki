import { Link } from 'react-router-dom'
import { HeartOff } from 'lucide-react'
import { cn } from '@/lib/cn'
import { cardVariants } from '@/components/ui/card'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { useCompanionStore } from '@/lib/companions/useCompanionStore'
import { CompanionCard } from '@/components/companions/store/CompanionCard'
import { CardGridSkeleton } from '@/components/store/SectionHead'

export function CompanionFavoritesPage() {
  const { favoriteCompanions, isLoading } = useCompanionStore()

  return (
    <PageContainer className="pb-20">
      <PageHeader
        title="Favorites"
        eyebrow="Companions"
        subtitle="Your pinned companions for quick switching."
      />

      {isLoading ? (
        <CardGridSkeleton count={4} />
      ) : favoriteCompanions.length === 0 ? (
        <div className={cn(cardVariants({ variant: 'dashed' }), 'flex flex-col items-center justify-center gap-3 py-20 text-center')}>
          <HeartOff className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No favorites yet. Tap the heart on any companion to pin it here.</p>
          <Link to="/companions/browse" className="text-sm font-medium text-brand hover:underline">Browse companions</Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {favoriteCompanions.map((c) => <CompanionCard key={c.id} c={c} />)}
        </div>
      )}
    </PageContainer>
  )
}
