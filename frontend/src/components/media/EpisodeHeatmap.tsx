// Season-by-episode IMDb ratings heatmap (the ratingraph/IMDb-style grid): spot the classic
// episodes and the season to skip at a glance. Data comes from IMDb's non-commercial datasets
// imported server-side; the first request triggers that import ("building" state).

import { useQuery } from '@tanstack/react-query'
import { Spinner } from '@/components/ui/spinner'

interface EpisodeRating {
  season: number
  episode: number
  rating: number
  votes: number
}

interface HeatmapResponse {
  available: boolean
  building: boolean
  episodes: EpisodeRating[]
}

// IMDb-style rating scale: green (great) through red (bad), constant across themes like
// chart colors. These are data-scale colors for the grid cells, not chrome.
function cellColor(rating: number): string {
  if (rating >= 8.5) return '#15803d' // design-ok(hex-in-tsx): ratings data color scale
  if (rating >= 7.5) return '#4d7c0f' // design-ok(hex-in-tsx): ratings data color scale
  if (rating >= 6.5) return '#a16207' // design-ok(hex-in-tsx): ratings data color scale
  if (rating >= 5.5) return '#c2410c' // design-ok(hex-in-tsx): ratings data color scale
  return '#b91c1c' // design-ok(hex-in-tsx): ratings data color scale
}

export function EpisodeHeatmap({ showId }: { showId: number | string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['show-heatmap', String(showId)],
    queryFn: async () => {
      const r = await fetch(`/api/shows/${showId}/ratings-heatmap`, { credentials: 'include' })
      if (!r.ok) return null
      return (await r.json()) as HeatmapResponse
    },
    staleTime: 60 * 60 * 1000,
    // While the server imports the datasets, poll until it flips to ready.
    refetchInterval: (q) => (q.state.data?.building ? 30_000 : false),
  })

  if (isLoading) return null
  if (data?.building) {
    return (
      <div className="flex items-center gap-2 rounded-card border border-border/50 bg-card/40 p-3 text-sm text-muted-foreground">
        <Spinner className="text-current" /> Preparing episode ratings (first run downloads the IMDb dataset)…
      </div>
    )
  }
  const eps = data?.episodes ?? []
  if (!data?.available || eps.length === 0) return null

  const seasons = new Map<number, EpisodeRating[]>()
  let maxEp = 0
  for (const e of eps) {
    seasons.set(e.season, [...(seasons.get(e.season) ?? []), e])
    if (e.episode > maxEp) maxEp = e.episode
  }
  if (maxEp > 30) maxEp = 30 // daily shows: cap the grid width, the tail adds no signal

  return (
    <div className="space-y-2">
      <h3 className="text-base font-semibold">Episode Ratings</h3>
      <div className="overflow-x-auto pb-2">
        <table className="border-separate border-spacing-0.5 text-[10px]">
          <thead>
            <tr>
              <th className="pr-1 text-left font-medium text-muted-foreground">S＼E</th>
              {Array.from({ length: maxEp }, (_, i) => (
                <th key={i} className="size-7 text-center font-normal text-muted-foreground">{i + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([season, list]) => (
              <tr key={season}>
                <td className="pr-1 font-medium text-muted-foreground">{season}</td>
                {Array.from({ length: maxEp }, (_, i) => {
                  const ep = list.find((e) => e.episode === i + 1)
                  return (
                    <td
                      key={i}
                      title={ep ? `S${season}E${i + 1}: ${ep.rating.toFixed(1)} (${ep.votes.toLocaleString()} votes)` : undefined}
                      className="size-7 rounded-[4px] text-center font-semibold text-white"
                      style={ep ? { backgroundColor: cellColor(ep.rating) } : undefined}
                    >
                      {ep ? ep.rating.toFixed(1) : ''}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">Ratings courtesy of IMDb (non-commercial datasets).</p>
    </div>
  )
}
