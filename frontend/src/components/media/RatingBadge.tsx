// Color-coded age-certification badge using the familiar parental-guidance color language:
// green = all ages, amber = guidance suggested, orange = 13+, red = mature. Covers both
// MPAA film ratings and US TV ratings; unknown values fall back to a neutral chip.

const GREEN = new Set(['G', 'TV-Y', 'TV-G'])
const AMBER = new Set(['PG', 'TV-Y7', 'TV-PG'])
const ORANGE = new Set(['PG-13', 'TV-14'])
const RED = new Set(['R', 'NC-17', 'TV-MA'])

export function RatingBadge({ rating, className }: { rating: string | null | undefined; className?: string }) {
  const r = (rating ?? '').trim().toUpperCase()
  if (!r) return null
  let cls = 'bg-foreground/10 text-muted-foreground'
  let style: React.CSSProperties | undefined
  if (GREEN.has(r)) cls = 'bg-success/15 text-success'
  else if (AMBER.has(r)) cls = 'bg-warning/15 text-warning'
  else if (ORANGE.has(r)) {
    cls = ''
    // design-ok(hex-in-tsx): the 13+ tier of the ratings color scale (green/amber/orange/red data colors)
    style = { backgroundColor: 'rgba(249, 115, 22, 0.15)', color: '#fb923c' }
  } else if (RED.has(r)) cls = 'bg-destructive/15 text-destructive'
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-bold tracking-wide ${cls} ${className ?? ''}`} style={style}>
      {r}
    </span>
  )
}
