import { Link, useParams } from 'react-router-dom'
import { ChevronRight, ShieldAlert } from 'lucide-react'
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

  const Icon = category.icon

  return (
    <div className="mx-auto max-w-6xl px-5 py-6 pb-20">
      <nav className="mb-4 flex items-center gap-1.5 text-sm">
        <Link to="/companions/categories" className="text-muted-foreground hover:text-foreground">Categories</Link>
        <ChevronRight className="size-3.5 text-muted-foreground/50" />
        <span className="font-medium text-foreground">{category.name}</span>
      </nav>

      <div className="relative mb-8 overflow-hidden rounded-3xl p-8 text-white shadow-lg" style={{ backgroundImage: category.gradient }}>
        <div className="absolute inset-0 bg-gradient-to-r from-black/45 to-transparent" />
        <Icon className="pointer-events-none absolute -right-4 top-1/2 size-52 -translate-y-1/2 text-white/10" />
        <div className="relative max-w-lg">
          <h1 className="text-4xl font-black tracking-tight drop-shadow">{category.name}</h1>
          <p className="mt-2 text-sm text-white/85">{category.blurb}</p>
          <p className="mt-4 text-xs font-medium text-white/70">
            {inCategory.length} {inCategory.length === 1 ? 'companion' : 'companions'}
            {lockedCount > 0 && ` · ${lockedCount} locked`}
          </p>
        </div>
      </div>

      {category.mature && (
        <div className="mb-6 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <p>These companions carry mature content. Any shown locked exceed your current content settings — raise them in Settings to unlock.</p>
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
    </div>
  )
}
