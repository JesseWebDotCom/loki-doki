import { Link } from 'react-router-dom'
import { HeartOff } from 'lucide-react'
import { useCompanionStore } from '@/lib/companions/useCompanionStore'
import { CompanionCard } from '@/components/companions/store/CompanionCard'
import { CardGridSkeleton } from '@/components/store/SectionHead'

export function CompanionFavoritesPage() {
  const { favoriteCompanions, isLoading } = useCompanionStore()

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-6 pb-20">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Favorites</h1>
        <p className="text-sm text-muted-foreground">Your pinned companions for quick switching.</p>
      </div>

      {isLoading ? (
        <CardGridSkeleton count={4} />
      ) : favoriteCompanions.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-20 text-center">
          <HeartOff className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No favorites yet. Tap the heart on any companion to pin it here.</p>
          <Link to="/companions/browse" className="text-sm font-medium text-brand hover:underline">Browse companions</Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
          {favoriteCompanions.map((c) => <CompanionCard key={c.id} c={c} />)}
        </div>
      )}
    </div>
  )
}
