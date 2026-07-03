import { ShieldCheck, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Card } from '@/components/ui/card'
import type { ContentRatingBlockData, ContentRatingCategory } from './types'

// Common Sense Media classifies these as "positive content"; everything else is a
// concern. Mirrors the site's two-column "Why age N+?" / "Any positive content?" layout.
const POSITIVE_LABELS = new Set([
  'Positive Messages',
  'Positive Role Models',
  'Diverse Representations',
  'Educational Value',
])

function Dots({ rating, positive }: { rating?: number; positive: boolean }) {
  if (typeof rating !== 'number') return null
  const filled = Math.max(0, Math.min(5, Math.round(rating)))
  return (
    <span className="flex items-center gap-[3px]" aria-label={`${filled} of 5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={cn(
            'size-[7px] rounded-full',
            i < filled ? (positive ? 'bg-success' : 'bg-foreground/80') : 'bg-foreground/15',
          )}
        />
      ))}
    </span>
  )
}

function CategoryRow({ cat, positive }: { cat: ContentRatingCategory; positive: boolean }) {
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium">{cat.label}</span>
        <Dots rating={cat.rating} positive={positive} />
      </div>
      {cat.detail && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{cat.detail}</p>}
    </div>
  )
}

export function ContentRatingCard({ data }: { data: ContentRatingBlockData }) {
  const concerns = data.categories.filter((c) => !POSITIVE_LABELS.has(c.label))
  const positives = data.categories.filter((c) => POSITIVE_LABELS.has(c.label))

  return (
    <Card variant="surface" className="text-sm">
      {/* Header: title + age badge */}
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border/30">
        <div className="min-w-0">
          <p className="font-semibold text-[14px] leading-snug truncate">{data.title}</p>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">Common Sense Media</p>
        </div>
        {data.ageRating && (
          <div className="flex items-center gap-1.5 shrink-0 rounded-full bg-success/10 px-2.5 py-1">
            <ShieldCheck className="size-3.5 text-success" />
            <span className="text-[12px] font-semibold text-success">Age {data.ageRating}</span>
          </div>
        )}
      </div>

      {/* Parents need to know */}
      {data.parentsNeedToKnow && (
        <div className="px-4 py-3 border-b border-border/30">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Parents Need to Know</p>
          <p className="text-[12px] leading-relaxed text-card-foreground/90">{data.parentsNeedToKnow}</p>
        </div>
      )}

      {/* Two-column breakdown */}
      {(concerns.length > 0 || positives.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 px-4 py-3">
          {concerns.length > 0 && (
            <div className="divide-y divide-border/30">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pb-1.5">
                {data.ageRating ? `Why Age ${data.ageRating}?` : 'Content concerns'}
              </p>
              {concerns.map((c, i) => <CategoryRow key={i} cat={c} positive={false} />)}
            </div>
          )}
          {positives.length > 0 && (
            <div className="divide-y divide-border/30">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pb-1.5">Any Positive Content?</p>
              {positives.map((c, i) => <CategoryRow key={i} cat={c} positive />)}
            </div>
          )}
        </div>
      )}

      {/* Source link */}
      {data.url && (
        <a
          href={data.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-4 py-2 border-t border-border/30 text-[11px] text-muted-foreground hover:bg-muted/30 transition-colors"
        >
          <ExternalLink className="size-3" />
          Full review on Common Sense Media
        </a>
      )}
    </Card>
  )
}
