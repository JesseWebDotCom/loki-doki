import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import { getItemSummary, getArticleSummaryByUrl } from '@/lib/feeds/api'

// AI TL;DR for the reader's right column's "Summary" tab. Generated on first open (feed items
// persist it server-side; headline-card URLs get a short-lived server cache), so repeat views
// are free. No section header of its own - the tab label already says "Summary".
export function NewsAiSummary({ id, url }: { id?: string; url?: string }) {
  const { data, isLoading } = useQuery({
    queryKey: id ? ['news-summary', id] : ['news-summary-url', url],
    queryFn: () => (id ? getItemSummary(id) : getArticleSummaryByUrl(url!)),
    enabled: !!id || !!url,
    staleTime: Infinity,
  })

  const summary = data?.summary
  if (!isLoading && !summary) return <p className="px-1 text-sm text-muted-foreground/70">No summary available.</p>

  if (isLoading) {
    return (
      <div className="space-y-2 px-1">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-4/6" />
      </div>
    )
  }

  return (
    <div className="space-y-2.5 px-1">
      {summary!.intro && <p className="text-sm leading-relaxed text-foreground/90">{summary!.intro}</p>}
      {summary!.bullets.length > 0 && (
        <ul className="space-y-1.5">
          {summary!.bullets.map((b, i) => (
            <li key={i} className="flex gap-2 text-sm leading-snug text-foreground/90">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-brand" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
