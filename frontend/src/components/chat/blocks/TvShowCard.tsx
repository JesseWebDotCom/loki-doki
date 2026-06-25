import { ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { FaviconImg } from '@/components/shared/FaviconImg'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import type { TvShowBlockData } from './types'

const STREAMING_DOMAINS: Record<string, string> = {
  'netflix': 'netflix.com',
  'hbo': 'hbo.com',
  'max': 'max.com',
  'hulu': 'hulu.com',
  'amazon': 'primevideo.com',
  'prime video': 'primevideo.com',
  'amazon prime video': 'primevideo.com',
  'apple tv+': 'tv.apple.com',
  'apple tv': 'tv.apple.com',
  'disney+': 'disneyplus.com',
  'disney plus': 'disneyplus.com',
  'peacock': 'peacocktv.com',
  'paramount+': 'paramountplus.com',
  'paramount plus': 'paramountplus.com',
  'showtime': 'showtime.com',
  'starz': 'starz.com',
  'amc': 'amc.com',
  'fx': 'fxnetworks.com',
  'bbc': 'bbc.co.uk',
  'bbc one': 'bbc.co.uk',
  'bbc two': 'bbc.co.uk',
  'amc+': 'amc.com',
  'youtube': 'youtube.com',
  'youtube premium': 'youtube.com',
  'discovery+': 'discoveryplus.com',
  'espn': 'espn.com',
  'cbs': 'cbs.com',
  'nbc': 'nbc.com',
  'abc': 'abc.com',
  'fox': 'fox.com',
  'cw': 'cwtv.com',
  'bravo': 'bravotv.com',
  'syfy': 'syfy.com',
  'usa': 'usanetwork.com',
  'tnt': 'tntdrama.com',
  'tbs': 'tbs.com',
  'cartoon network': 'cartoonnetwork.com',
  'adult swim': 'adultswim.com',
  'comedy central': 'comedycentral.com',
}

function networkFaviconDomain(network: string): string | null {
  return STREAMING_DOMAINS[network.toLowerCase()] ?? null
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'Running') return 'default'
  if (status === 'Ended') return 'secondary'
  if (status === 'To Be Determined') return 'outline'
  return 'secondary'
}

export function TvShowCard({ data }: { data: TvShowBlockData }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card overflow-hidden text-sm">
      {/* Header */}
      <div className="flex gap-0">
        {data.image && (
          <div className="shrink-0 w-24 overflow-hidden">
            <img
              src={proxyImg(data.image)}
              alt={data.name}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          </div>
        )}
        <div className="flex-1 min-w-0 px-4 py-3">
          <div className="flex items-start gap-2 mb-1.5">
            <p className="font-semibold text-[13px] leading-snug flex-1">{data.name}</p>
            {data.status && (
              <Badge variant={statusVariant(data.status)} className="text-[10px] shrink-0">
                {data.status}
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground mb-2">
            {data.network && (
              <span className="flex items-center gap-1">
                {networkFaviconDomain(data.network) && (
                  <FaviconImg domain={networkFaviconDomain(data.network)!} />
                )}
                {data.network}
              </span>
            )}
            {data.rating && <span>⭐ {data.rating}/10</span>}
            {data.seasonCount > 0 && <span>{data.seasonCount} season{data.seasonCount !== 1 ? 's' : ''}</span>}
            {data.premiered && (
              <span>
                {data.premiered.slice(0, 4)}
                {data.ended && data.ended !== data.premiered ? `–${data.ended.slice(0, 4)}` : data.status === 'Running' ? '–present' : ''}
              </span>
            )}
          </div>

          {data.genres.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {data.genres.slice(0, 4).map(g => (
                <Badge key={g} variant="outline" className="text-[10px]">{g}</Badge>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Summary */}
      {data.summary && (
        <div className="border-t border-border/30 px-4 py-3">
          <p className="text-[12px] leading-relaxed text-card-foreground/90 line-clamp-3">{data.summary}</p>
          {data.url && (
            <a
              href={data.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="size-3" /> More on TVMaze
            </a>
          )}
        </div>
      )}

      {/* Recent news */}
      {data.recentNews.length > 0 && (
        <div className="border-t border-border/30 px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">Recent News</p>
          <div className="flex flex-col gap-1.5">
            {data.recentNews.slice(0, 3).map((item, i) => (
              <a
                key={i}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'group text-[12px] text-card-foreground/80 hover:text-foreground transition-colors line-clamp-1',
                )}
              >
                · {item.title}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
