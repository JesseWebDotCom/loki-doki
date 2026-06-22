import { Link } from 'react-router-dom'
import { cn } from '@/lib/cn'

/** "Title ........ View all" section header used across store pages. */
export function SectionHead({ title, viewAllTo, className }: { title: string; viewAllTo?: string; className?: string }) {
  return (
    <div className={cn('mb-4 flex items-center justify-between', className)}>
      <h2 className="text-lg font-bold tracking-tight">{title}</h2>
      {viewAllTo && (
        <Link to={viewAllTo} className="text-sm font-medium text-brand hover:underline">
          View all
        </Link>
      )}
    </div>
  )
}

/** Grid-of-cards loading placeholder. */
export function CardGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-2xl border border-border/30 bg-card/40 p-4">
          <div className="size-16 animate-pulse rounded-2xl bg-muted/60" />
          <div className="mt-1 space-y-1.5">
            <div className="h-3 w-3/4 animate-pulse rounded bg-muted/60" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted/40" />
          </div>
          <div className="mt-auto h-7 animate-pulse rounded-full bg-muted/50" />
        </div>
      ))}
    </div>
  )
}
