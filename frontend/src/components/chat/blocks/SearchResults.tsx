import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { FaviconImg } from '@/components/shared/FaviconImg'
import type { SearchBlockData } from './types'

export function SearchResults({ data }: { data: SearchBlockData }) {
  if (!data.results.length) return null

  return (
    <div className="flex flex-col gap-2">
      {data.inTheaters && (
        <div className="flex">
          <Badge variant="default" className="text-[11px]">🎬 In Theaters</Badge>
        </div>
      )}
      <Card variant="surface" className="flex flex-col divide-y divide-border/40">
        {data.results.map((result, i) => {
          const domain = (() => {
            try { return new URL(result.url).hostname.replace(/^www\./, '') }
            catch { return '' }
          })()

          return (
            <a
              key={i}
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-start gap-3 px-3.5 py-3 hover:bg-muted/30 transition-colors"
            >
              <span className="mt-0.5 shrink-0 text-[10px] font-semibold text-muted-foreground/60 w-4">
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-card-foreground group-hover:text-foreground line-clamp-1 mb-0.5">
                  {result.title}
                </p>
                <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
                  {result.snippet}
                </p>
                {domain && (
                  <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/60">
                    <FaviconImg domain={domain} />
                    {domain}
                  </p>
                )}
              </div>
            </a>
          )
        })}
      </Card>
    </div>
  )
}
