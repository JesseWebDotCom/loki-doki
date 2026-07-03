import { ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import type { NewsBlockData } from './types'

function relativeTime(pubDate: string): string {
  try {
    const ms = Date.now() - new Date(pubDate).getTime()
    const h = Math.floor(ms / 3_600_000)
    if (h < 1) return 'Just now'
    if (h < 24) return `${h}h ago`
    const d = Math.floor(h / 24)
    if (d < 7) return `${d}d ago`
    return new Date(pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

export function NewsCards({ data }: { data: NewsBlockData }) {
  if (!data.items.length) return null

  return (
    <div className="flex flex-col gap-2">
      {data.category && (
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {data.category} News
        </p>
      )}
      <Card variant="surface" className="flex flex-col divide-y divide-border/40">
        {data.items.map((item, i) => (
          <a
            key={i}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-start gap-3 px-3.5 py-3 hover:bg-muted/30 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium leading-snug text-card-foreground group-hover:text-foreground line-clamp-2 mb-1">
                {item.title}
              </p>
              <div className="flex items-center gap-2">
                {item.source && (
                  <Badge variant="secondary" className="text-[10px] h-4 px-1.5 shrink-0">
                    {item.source}
                  </Badge>
                )}
                {item.published && (
                  <span className="text-[10px] text-muted-foreground">{relativeTime(item.published)}</span>
                )}
              </div>
            </div>
            <ExternalLink className="size-3 shrink-0 mt-0.5 text-muted-foreground/50 group-hover:text-muted-foreground" />
          </a>
        ))}
      </Card>
    </div>
  )
}
