// "Suggested for you" rail for the Shows and Movies home pages, fed by the interest
// engine. Polls while the first pool build runs (building:true), hides when empty, and
// gives every card a "Not interested" X (optimistic hide + Undo toast).

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MediaShelfRow, type PosterItem } from '@/components/media/TitleCard'
import { getSuggestedShows } from '@/lib/shows/api'
import { getSuggestedMovies, movieTo } from '@/lib/movies/api'
import { useSuggestionDismiss } from '@/hooks/useSuggestionDismiss'

// The two endpoints return differently-shaped items; the query holds them as a common
// ref-bearing shape and the poster mapping below narrows per kind.
interface SuggestedResponse {
  items: Array<Record<string, unknown> & { ref: string }>
  building: boolean
}

export function SuggestedTitlesShelf({ kind }: { kind: 'show' | 'movie' }) {
  const domain = kind === 'show' ? 'shows' : 'movies'
  const { data } = useQuery({
    queryKey: [`${domain}-suggested`],
    queryFn: (kind === 'show' ? getSuggestedShows : getSuggestedMovies) as unknown as () => Promise<SuggestedResponse>,
    staleTime: 5 * 60_000,
    refetchInterval: (query) => (query.state.data?.building ? 20_000 : false),
  })
  const { hidden, dismiss } = useSuggestionDismiss(domain)

  const posters: PosterItem[] = useMemo(() => {
    const items = data?.items ?? []
    if (kind === 'show') {
      return (items as unknown as Array<{ ref: string; id: number; name: string; network: string | null; year: string | null; poster: string | null; rating: number | null }>)
        .filter((s) => !hidden.has(s.ref))
        .map((s) => ({
          ref: s.ref,
          to: `/shows/${s.id}`,
          title: s.name,
          subtitle: [s.network, s.year].filter(Boolean).join(' · ') || null,
          poster: s.poster,
          rating: s.rating,
        }))
    }
    return (items as unknown as Array<{ ref: string; title: string; year: number | null; poster: string | null; genre: string | null }>)
      .filter((m) => !hidden.has(m.ref))
      .map((m) => ({
        ref: m.ref,
        to: movieTo(m),
        title: m.title,
        subtitle: [m.genre, m.year].filter(Boolean).join(' · ') || null,
        poster: m.poster,
      }))
  }, [data, hidden, kind])

  if (!posters.length) return null
  return (
    <MediaShelfRow
      title="Suggested for you"
      items={posters}
      onDismiss={(item) => item.ref && dismiss({ ref: item.ref, title: item.title })}
    />
  )
}
