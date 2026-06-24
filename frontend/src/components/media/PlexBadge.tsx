import { useQuery } from '@tanstack/react-query'
import { PlayCircle, Server } from 'lucide-react'
import { findInPlex, getPlexStatus } from '@/lib/plex/api'

// Shows "In your Plex library" + a Play-on-Plex deep link when the title is found on the
// user's configured Plex server. Renders nothing when Plex isn't configured or the title
// isn't present, so it's safe to drop onto any detail page.
export function PlexBadge({
  type,
  title,
  year,
  imdb,
  tvdb,
}: {
  type: 'movie' | 'show'
  title: string
  year?: number | null
  imdb?: string | null
  tvdb?: number | null
}) {
  const { data: status } = useQuery({ queryKey: ['plex-status'], queryFn: getPlexStatus, staleTime: 5 * 60 * 1000 })
  const enabled = !!status?.configured && !!title

  const { data: match } = useQuery({
    queryKey: ['plex-find', type, title, year, imdb, tvdb],
    queryFn: () => findInPlex({ type, title, year, imdb, tvdb }),
    enabled,
    staleTime: 5 * 60 * 1000,
  })

  if (!enabled || !match?.present) return null

  return (
    <a
      href={match.deepLink ?? '#'}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/15 px-3 py-1.5 text-sm font-medium text-amber-300 transition-colors hover:bg-amber-500/25"
    >
      {match.deepLink ? <PlayCircle className="size-4" /> : <Server className="size-4" />}
      {match.deepLink ? 'Play on Plex' : 'In your Plex'}
    </a>
  )
}
