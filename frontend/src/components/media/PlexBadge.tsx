import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Server, MonitorPlay } from 'lucide-react'
import { findInPlex, getPlexStatus, getPlexMeta } from '@/lib/plex/api'
import { PlexPlayer } from './PlexPlayer'
import { Button } from '@/components/ui/button'

// Shows a "View on Plex" link (opens the item's page in Plex; it doesn't auto-play, so the
// label avoids implying playback) when the title is found on the user's configured Plex server,
// plus a "Play here" button for browser-playable files (streamed in-app). Renders nothing when
// Plex isn't configured or the title isn't present, so it's safe to drop onto any detail page.
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
  const [playing, setPlaying] = useState(false)
  const { data: status } = useQuery({ queryKey: ['plex-status'], queryFn: getPlexStatus, staleTime: 5 * 60 * 1000 })
  const enabled = !!status?.configured && !!title

  const { data: match } = useQuery({
    queryKey: ['plex-find', type, title, year, imdb, tvdb],
    queryFn: () => findInPlex({ type, title, year, imdb, tvdb }),
    enabled,
    staleTime: 5 * 60 * 1000,
  })

  // Movies are a single playable item; a show's ratingKey is the series, not an episode, so
  // in-app direct play only makes sense for movies here.
  const ratingKey = match?.ratingKey ?? null
  const { data: meta } = useQuery({
    queryKey: ['plex-meta', ratingKey],
    queryFn: () => getPlexMeta(ratingKey as string),
    enabled: !!ratingKey && type === 'movie',
    staleTime: 5 * 60 * 1000,
  })

  if (!enabled || !match?.present) return null

  return (
    <div className="inline-flex items-center gap-2">
      {meta?.directPlay && ratingKey && (
        <Button
          variant="tinted"
          size="sm"
          onClick={() => setPlaying(true)}
          className="gap-1.5 bg-warning/15 text-warning hover:bg-warning/25"
        >
          <MonitorPlay className="size-4" />
          Play here
        </Button>
      )}
      <a
        href={match.deepLink ?? '#'}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-8 items-center gap-1.5 rounded-full bg-warning/15 px-3 text-sm font-medium text-warning transition-colors hover:bg-warning/25"
      >
        {match.deepLink ? <ExternalLink className="size-4" /> : <Server className="size-4" />}
        {match.deepLink ? 'View on Plex' : 'In your Plex'}
      </a>
      {playing && ratingKey && <PlexPlayer ratingKey={ratingKey} title={match.title ?? title} onClose={() => setPlaying(false)} />}
    </div>
  )
}
