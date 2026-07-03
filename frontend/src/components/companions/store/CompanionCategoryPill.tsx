import { Link } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { cardVariants } from '@/components/ui/card'
import { AppIconTile } from '@/components/shared/AppIconTile'
import type { CompanionCategory } from '@/lib/companions/companionCategories'

/** Icon + label chip linking to a category page (home Categories row).
 *  Mirrors the App Store's CategoryPill idiom. */
export function CompanionCategoryPill({ category, className }: { category: CompanionCategory; className?: string }) {
  return (
    <Link
      to={`/companions/category/${category.key}`}
      className={cn(
        'group flex items-center gap-3 rounded-card border border-border bg-card px-4 py-3.5',
        'transition-colors hover:border-brand/40',
        className,
      )}
    >
      <AppIconTile icon={category.icon} gradient={category.gradient} color={category.color} variant="flat" size="md" />
      <span className="text-sm font-semibold">{category.name}</span>
    </Link>
  )
}

/** Category card for the Categories index page - a calm neutral surface with a
 *  flat-colored icon tile (mirrors the App Store's CategoryCard). */
export function CompanionCategoryCard({ category, count }: { category: CompanionCategory; count: number }) {
  const Icon = category.icon
  return (
    <Link
      to={`/companions/category/${category.key}`}
      className={cn(cardVariants({ variant: 'interactive' }), 'flex h-36 flex-col justify-between p-5')}
    >
      <span
        className="flex size-11 shrink-0 items-center justify-center rounded-control"
        style={{ backgroundColor: `color-mix(in oklch, ${category.color} 18%, transparent)` }}
      >
        <Icon className="size-5" style={{ color: category.color }} />
      </span>
      <div>
        <p className="text-base font-semibold">{category.name}</p>
        <p className="text-caption text-muted-foreground">{count} {count === 1 ? 'companion' : 'companions'}</p>
      </div>
    </Link>
  )
}
