import { Link } from 'react-router-dom'
import { cn } from '@/lib/cn'
import type { CompanionCategory } from '@/lib/companions/companionCategories'

/** Icon + label chip linking to a category page (home Categories row). */
export function CompanionCategoryPill({ category, className }: { category: CompanionCategory; className?: string }) {
  const Icon = category.icon
  return (
    <Link
      to={`/companions/category/${category.key}`}
      className={cn(
        'group flex items-center gap-3 rounded-2xl border border-border/40 bg-card px-4 py-3.5',
        'transition-colors hover:border-border hover:bg-accent/40',
        className,
      )}
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-xl shadow-sm"
        style={{ backgroundImage: category.gradient }}
      >
        <Icon className="size-5 text-white" />
      </span>
      <span className="text-sm font-semibold">{category.name}</span>
    </Link>
  )
}

/** Large gradient category card for the Categories index page. */
export function CompanionCategoryCard({ category, count }: { category: CompanionCategory; count: number }) {
  const Icon = category.icon
  return (
    <Link
      to={`/companions/category/${category.key}`}
      className="group relative flex h-36 flex-col justify-between overflow-hidden rounded-2xl p-5 text-white shadow-md transition-transform hover:scale-[1.015]"
      style={{ backgroundImage: category.gradient }}
    >
      <div className="absolute inset-0 bg-black/10 transition-colors group-hover:bg-black/0" />
      <Icon className="relative size-7 drop-shadow" />
      <div className="relative">
        <p className="text-lg font-bold drop-shadow">{category.name}</p>
        <p className="text-xs font-medium text-white/80">{count} {count === 1 ? 'companion' : 'companions'}</p>
      </div>
    </Link>
  )
}
