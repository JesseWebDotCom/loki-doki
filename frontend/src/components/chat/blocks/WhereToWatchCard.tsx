import { ExternalLink, TrendingUp, Sparkles, Ticket } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { FaviconImg } from '@/components/shared/FaviconImg'
import { proxyImg } from '@/lib/img'
import type { WhereToWatchBlockData, WhereToWatchItem, WhereToWatchProvider } from './types'

const PROVIDER_DOMAINS: Record<string, string> = {
  netflix: 'netflix.com',
  'hbo max': 'max.com',
  max: 'max.com',
  hulu: 'hulu.com',
  'amazon prime video': 'primevideo.com',
  'prime video': 'primevideo.com',
  'amazon video': 'primevideo.com',
  'apple tv+': 'tv.apple.com',
  'apple tv': 'tv.apple.com',
  'disney+': 'disneyplus.com',
  'disney plus': 'disneyplus.com',
  peacock: 'peacocktv.com',
  'peacock premium': 'peacocktv.com',
  'paramount+': 'paramountplus.com',
  'paramount plus': 'paramountplus.com',
  showtime: 'showtime.com',
  starz: 'starz.com',
  'amc+': 'amc.com',
  'discovery+': 'discoveryplus.com',
  youtube: 'youtube.com',
  'google play movies': 'play.google.com',
  'youtube premium': 'youtube.com',
  vudu: 'vudu.com',
  'fandango at home': 'vudu.com',
  tubi: 'tubitv.com',
  pluto: 'pluto.tv',
  'pluto tv': 'pluto.tv',
  crunchyroll: 'crunchyroll.com',
}

function providerDomain(name: string): string | null {
  return PROVIDER_DOMAINS[name.toLowerCase()] ?? null
}

function offerVariant(offerType: string): 'default' | 'secondary' | 'outline' {
  if (offerType === 'FLATRATE') return 'default'
  if (offerType === 'FREE' || offerType === 'ADS') return 'secondary'
  return 'outline'
}

function ProviderRow({ p }: { p: WhereToWatchProvider }) {
  const domain = providerDomain(p.name)
  const inner = (
    <span className="flex items-center gap-2 min-w-0">
      {domain && <FaviconImg domain={domain} />}
      <span className="truncate font-medium text-[12px]">{p.name}</span>
      <Badge variant={offerVariant(p.offerType)} className="text-[10px] shrink-0">{p.label}</Badge>
    </span>
  )
  return p.url ? (
    <a href={p.url} target="_blank" rel="noopener noreferrer"
      className="flex items-center justify-between gap-2 rounded-control px-2 py-1.5 hover:bg-muted/60 transition-colors">
      {inner}
      <ExternalLink className="size-3 text-muted-foreground shrink-0" />
    </a>
  ) : (
    <div className="flex items-center justify-between gap-2 rounded-control px-2 py-1.5">{inner}</div>
  )
}

function BrowseRow({ item }: { item: WhereToWatchItem }) {
  const sub: string[] = []
  if (item.year) sub.push(String(item.year))
  if (item.objectType === 'MOVIE') sub.push('Movie')
  else if (item.objectType === 'SHOW') sub.push('TV Show')
  const lead = item.providers[0]
  const body = (
    <div className="flex items-center gap-3 px-3 py-2">
      {item.posterUrl
        ? <img src={proxyImg(item.posterUrl)} alt="" className="h-12 w-9 shrink-0 rounded-card object-cover" loading="lazy" />
        : <div className="h-12 w-9 shrink-0 rounded-card bg-muted" />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium">{item.title}</p>
        {sub.length > 0 && <p className="text-[11px] text-muted-foreground">{sub.join(' · ')}</p>}
      </div>
      {lead && (
        <span className="flex shrink-0 items-center gap-1.5">
          {providerDomain(lead.name) && <FaviconImg domain={providerDomain(lead.name)!} />}
          <span className="text-[11px] text-muted-foreground">{lead.name}</span>
        </span>
      )}
    </div>
  )
  return item.justwatchUrl
    ? <a href={item.justwatchUrl} target="_blank" rel="noopener noreferrer" className="block hover:bg-muted/60 transition-colors">{body}</a>
    : <div>{body}</div>
}

function BrowseCard({ data }: { data: WhereToWatchBlockData }) {
  const items = data.items ?? []
  const Icon = data.browseLabel === 'New' ? Sparkles : TrendingUp
  return (
    <Card variant="surface" className="text-sm">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30">
        <Icon className="size-4 text-muted-foreground" />
        <p className="text-[12px] font-medium">
          {data.browseLabel} titles{data.provider ? ` on ${data.provider}` : ''}{data.country ? ` · ${data.country}` : ''}
        </p>
      </div>
      <div className="divide-y divide-border/20">
        {items.slice(0, 8).map((it, i) => <BrowseRow key={`${it.title}-${i}`} item={it} />)}
      </div>
    </Card>
  )
}

export function WhereToWatchCard({ data }: { data: WhereToWatchBlockData }) {
  if (data.mode === 'browse') return <BrowseCard data={data} />

  const providers = data.providers ?? []
  const theaters = data.theaters ?? []
  const meta: string[] = []
  if (data.year) meta.push(String(data.year))
  if (data.objectType === 'MOVIE') meta.push('Movie')
  else if (data.objectType === 'SHOW') meta.push('TV Show')
  if (data.ageCertification) meta.push(data.ageCertification)
  if (data.runtimeMinutes && data.runtimeMinutes > 0) meta.push(`${data.runtimeMinutes}m`)

  return (
    <Card variant="surface" className="text-sm">
      <div className="flex gap-0">
        {data.posterUrl && (
          <div className="shrink-0 w-20 overflow-hidden">
            <img src={proxyImg(data.posterUrl)} alt={data.title} className="w-full h-full object-cover" loading="lazy" />
          </div>
        )}
        <div className="flex-1 min-w-0 px-4 py-3">
          <p className="font-semibold text-[13px] leading-snug">{data.title}</p>
          {meta.length > 0 && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{meta.join(' · ')}</p>
          )}
          {theaters.length > 0 && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">
              <Ticket className="size-3" /> In theaters now
            </span>
          )}
        </div>
      </div>

      {/* In theaters - buy tickets */}
      {theaters.length > 0 && (
        <div className="border-t border-border/30 px-2 py-2">
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">In theaters</p>
          <div className="flex flex-col">
            {theaters.slice(0, 4).map((t, i) => (
              <a key={`${t.name}-${i}`} href={t.url || undefined} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-between gap-2 rounded-control px-2 py-1.5 hover:bg-muted/60 transition-colors">
                <span className="flex items-center gap-2 min-w-0">
                  <Ticket className="size-3.5 text-warning shrink-0" />
                  <span className="truncate font-medium text-[12px]">{t.name}</span>
                  <span className="text-[11px] text-muted-foreground">tickets</span>
                </span>
                {t.url && <ExternalLink className="size-3 text-muted-foreground shrink-0" />}
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-border/30 px-2 py-2">
        <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Streaming in {data.country}
        </p>
        {providers.length > 0 ? (
          <div className="flex flex-col">
            {providers.slice(0, 8).map((p, i) => <ProviderRow key={`${p.name}-${p.offerType}-${i}`} p={p} />)}
          </div>
        ) : (
          <p className="px-2 py-1.5 text-[12px] text-muted-foreground">
            {theaters.length > 0 ? `Not streaming yet - in theaters only.` : `Not currently streaming in ${data.country}.`}
          </p>
        )}
      </div>

      {data.justwatchUrl && (
        <div className="border-t border-border/30 px-4 py-2">
          <a href={data.justwatchUrl} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
            <ExternalLink className="size-3" /> View on JustWatch
          </a>
        </div>
      )}
    </Card>
  )
}
