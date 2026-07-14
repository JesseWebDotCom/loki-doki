import { useQuery } from '@tanstack/react-query'
import { Skeleton } from '@/components/ui/skeleton'
import { search, type SearchResponse } from '@/lib/youtube/api'
import { searchToItem } from '@/lib/youtube/types'
import { UpNextRow } from '@/components/youtube/VideoCard'

// A full headline is often too specific to search well - exact punctuation, numbers, and
// word combinations can tip YouTube's search to zero results even when a shorter phrase from
// the same headline returns plenty (confirmed live: trimming didn't reliably help at any one
// fixed length - one headline needed 7 words, another needed fewer). So instead of guessing a
// single cutoff, try progressively shorter prefixes of the title until one returns results.
function candidateQueries(title: string): string[] {
  const words = title.replace(/[$"'“”‘’]/g, '').split(/\s+/).filter(Boolean)
  const lens = [10, 7, 5, 3]
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of lens) {
    const q = words.slice(0, n).join(' ')
    if (q && !seen.has(q)) { seen.add(q); out.push(q) }
  }
  return out
}

async function searchRelated(title: string): Promise<SearchResponse> {
  for (const q of candidateQueries(title)) {
    const res = await search(q, undefined, 'videos')
    if (res.results?.length) return res
  }
  return { results: [] }
}

// Related videos for the reader's right column's "Related videos" tab - a plain YouTube video
// search seeded from the article's title, reusing the same search + card pieces as the
// YouTube app. No section header of its own - the tab label already says "Related videos".
export function NewsRelatedVideos({ query }: { query: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['news-related-videos', query],
    queryFn: () => searchRelated(query),
    enabled: !!query,
    staleTime: 10 * 60_000,
  })
  const videos = (data?.results ?? []).slice(0, 6).map(searchToItem)

  if (!isLoading && videos.length === 0) return <p className="px-1 text-sm text-muted-foreground/70">No related videos found.</p>

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {videos.map((v) => <UpNextRow key={v.videoId} item={v} />)}
    </div>
  )
}
