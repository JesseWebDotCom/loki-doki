import { cn } from '@/lib/cn'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Skeleton } from '@/components/ui/skeleton'

/** Thin wrapper over the shared SectionHeader with the store's default spacing.
 *  Kept for legacy callers (podcast pages); new store code uses SectionHeader directly. */
export function SectionHead({ title, viewAllTo, className }: { title: string; viewAllTo?: string; className?: string }) {
  return <SectionHeader title={title} to={viewAllTo} className={cn('mb-4', className)} />
}

/** Grid-of-cards loading placeholder mirroring the app-card geometry. */
export function CardGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-card border border-border bg-card p-4">
          <Skeleton className="size-16 rounded-card" />
          <div className="mt-1 space-y-1.5">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
          <Skeleton className="mt-auto h-7 rounded-full" />
        </div>
      ))}
    </div>
  )
}
