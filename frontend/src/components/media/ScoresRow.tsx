import { Star, BadgeCheck } from 'lucide-react'
import type { TitleScoring } from '@/lib/shows/api'

function fmtVotes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/** Real aggregate scores (IMDb / Rotten Tomatoes / TMDB) as compact badges. Renders nothing
 *  when no score is known, so callers can drop it in unconditionally. */
export function ScoresRow({ scoring, className }: { scoring: TitleScoring | null | undefined; className?: string }) {
  if (!scoring) return null
  const { imdbScore, imdbVotes, tomatoMeter, certifiedFresh, tmdbScore } = scoring
  if (imdbScore == null && tomatoMeter == null && tmdbScore == null) return null
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ''}`}>
      {imdbScore != null && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-semibold text-warning">
          <Star className="size-3.5 fill-warning" />
          IMDb {imdbScore.toFixed(1)}
          {imdbVotes != null && <span className="font-normal text-warning/80">({fmtVotes(imdbVotes)})</span>}
        </span>
      )}
      {tomatoMeter != null && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/15 px-2.5 py-1 text-xs font-semibold text-destructive">
          🍅 {tomatoMeter}%
          {certifiedFresh && (
            <span className="inline-flex items-center gap-0.5 font-normal text-destructive/80">
              <BadgeCheck className="size-3.5" /> Certified Fresh
            </span>
          )}
        </span>
      )}
      {tmdbScore != null && (
        <span className="inline-flex items-center rounded-full bg-info/15 px-2.5 py-1 text-xs font-semibold text-info">
          TMDB {tmdbScore.toFixed(1)}
        </span>
      )}
    </div>
  )
}
