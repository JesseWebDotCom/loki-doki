// Broadcast news: one featured story at a time (image, headline, summary)
// auto-advancing every 12 seconds, with a crawling ticker of the remaining
// headlines along the bottom.

import { useQuery } from '@tanstack/react-query'
import { Newspaper } from 'lucide-react'
import type { TvScreenProps } from './index'
import { ScreenFrame, StatusPanel, agoLabel, channelPanelStyle, getJson, useCycle } from './shared'

interface NewsItem {
  title: string
  url?: string
  source?: string
  summary?: string
  imageUrl?: string
  publishedAt?: number
}

interface NewsResponse { items: NewsItem[]; offline?: boolean }

const TICKER_KEYFRAMES = '@keyframes maipaitv-ticker { from { transform: translateX(0) } to { transform: translateX(-50%) } }'

function interleave(a: NewsItem[], b: NewsItem[]): NewsItem[] {
  const out: NewsItem[] = []
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (a[i]) out.push(a[i])
    if (b[i]) out.push(b[i])
  }
  const seen = new Set<string>()
  return out.filter((item) => {
    const key = item.title.toLowerCase().slice(0, 60)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function NewsScreen({ channel, title, subtitle }: TvScreenProps) {
  const localFirst = title.toLowerCase().includes('local')
  const world = useQuery({
    queryKey: ['maipaitv', 'news', 'world'],
    queryFn: () => getJson<NewsResponse>('/api/news/?type=world&limit=12'),
    refetchInterval: 10 * 60_000,
  })
  const local = useQuery({
    queryKey: ['maipaitv', 'news', 'local'],
    queryFn: () => getJson<NewsResponse>('/api/news/?type=local&limit=12'),
    refetchInterval: 10 * 60_000,
  })

  const worldItems = world.data?.items ?? []
  const localItems = local.data?.items ?? []
  const items = localFirst ? interleave(localItems, worldItems) : interleave(worldItems, localItems)
  const featuredIdx = useCycle(Math.min(items.length, 8), 12_000)

  if (world.isPending && local.isPending) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={Newspaper} headline="Gathering headlines" note="Waiting for data" />
      </ScreenFrame>
    )
  }
  if (items.length === 0) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={Newspaper} headline="The newsroom is quiet" note="Headlines will return shortly" />
      </ScreenFrame>
    )
  }

  const featured = items[featuredIdx]
  const tickerItems = items.filter((_, i) => i !== featuredIdx).slice(0, 12)
  const tickerLoop = [...tickerItems, ...tickerItems]
  const tickerSeconds = Math.max(30, tickerItems.reduce((n, it) => n + it.title.length, 0) / 6)

  return (
    <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
      <style>{TICKER_KEYFRAMES}</style>
      <div className="flex h-full flex-col gap-6">
        <div key={featured.title} className="flex min-h-0 flex-1 gap-8">
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-5">
            <span className="flex items-center gap-3 text-sm font-bold uppercase tracking-[0.3em] text-muted-foreground">
              <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: channel.color }} />
              {featured.source ?? 'Top story'}
              {featured.publishedAt ? <span className="normal-case tracking-normal">{agoLabel(featured.publishedAt)}</span> : null}
            </span>
            <p className="line-clamp-3 text-4xl font-bold leading-tight tracking-tight xl:text-5xl">{featured.title}</p>
            {featured.summary ? (
              <p className="line-clamp-4 max-w-3xl text-xl leading-relaxed text-muted-foreground">{featured.summary}</p>
            ) : null}
          </div>
          <div className="hidden w-2/5 shrink-0 overflow-hidden rounded-sheet border border-border/50 lg:block">
            {featured.imageUrl ? (
              <img src={featured.imageUrl} alt="" decoding="async" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center" style={channelPanelStyle(channel)}>
                <Newspaper className="size-24 text-foreground/60" />
              </div>
            )}
          </div>
        </div>

        {tickerItems.length > 0 ? (
          <div className="flex h-16 shrink-0 items-center overflow-hidden rounded-card border border-border/50 bg-card/50">
            <span
              className="flex h-full shrink-0 items-center px-6 text-sm font-bold uppercase tracking-[0.25em] text-foreground"
              style={channelPanelStyle(channel)}
            >
              Latest
            </span>
            <div className="relative min-w-0 flex-1 overflow-hidden">
              <div
                className="flex w-max items-center whitespace-nowrap"
                style={{ animation: `maipaitv-ticker ${Math.round(tickerSeconds)}s linear infinite` }}
              >
                {tickerLoop.map((it, i) => (
                  <span key={`${it.title}-${i}`} className="flex items-center text-xl">
                    <span className="px-6">{it.title}</span>
                    <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: channel.color }} />
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </ScreenFrame>
  )
}
