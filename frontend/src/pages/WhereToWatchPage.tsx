import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Film, Tv, WifiOff } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { SkeletonListRows } from '@/components/shared/SkeletonBlocks'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { Card, cardVariants } from '@/components/ui/card'
import { cn } from '@/lib/cn'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import {
  whereToWatchPopularQueryOptions,
  whereToWatchSearchQueryOptions,
  type Provider,
  type TitleCard,
} from '@/lib/whereToWatch'

// ── Provider badge ────────────────────────────────────────────────────────────

function ProviderBadge({ provider }: { provider: Provider }) {
  const isSubscription = provider.offerType === 'FLATRATE' || provider.offerType === 'FREE' || provider.offerType === 'ADS'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-none',
        isSubscription
          ? 'bg-brand/15 text-brand'
          : 'bg-muted text-muted-foreground',
      )}
    >
      {provider.name}
    </span>
  )
}

// ── Title card ────────────────────────────────────────────────────────────────

function TitleCardItem({ card }: { card: TitleCard }) {
  const [imgOk, setImgOk] = useState(true)
  const url = card.justwatchUrl || undefined

  const inner = (
    <div className="flex gap-3 p-3">
      <div className="relative size-16 shrink-0 overflow-hidden rounded-control bg-muted/60">
        {card.posterUrl && imgOk ? (
          <img
            src={card.posterUrl}
            alt={card.title}
            className="size-full object-cover"
            loading="lazy"
            onError={() => setImgOk(false)}
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            <Film className="size-6 text-muted-foreground/40" />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold leading-snug">{card.title}</p>
        {card.year != null && (
          <p className="mt-0.5 text-xs text-muted-foreground">{card.year}</p>
        )}
        {card.providers.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {card.providers.slice(0, 4).map((p, i) => (
              <ProviderBadge key={`${p.name}-${i}`} provider={p} />
            ))}
          </div>
        )}
        {card.providers.length === 0 && (
          <p className="mt-1 text-[10px] text-muted-foreground/60">No streaming options found</p>
        )}
      </div>
    </div>
  )

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(cardVariants({ variant: 'interactive' }), 'group block')}
      >
        {inner}
      </a>
    )
  }

  return (
    <Card className="border-border/60">
      {inner}
    </Card>
  )
}

// ── Chip filter row ───────────────────────────────────────────────────────────

function FilterChips({
  providers,
  selected,
  onSelect,
}: {
  providers: string[]
  selected: string
  onSelect: (p: string) => void
}) {
  if (providers.length === 0) return null

  return (
    <ChipRow className="flex-wrap gap-1.5 pb-3">
      {['All', ...providers].map((p) => (
        <Chip
          key={p}
          label={p}
          active={(p === 'All' && !selected) || selected === p}
          onClick={() => onSelect(p === 'All' ? '' : p)}
        />
      ))}
    </ChipRow>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function WhereToWatchPage() {
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [selectedProvider, setSelectedProvider] = useState('')

  usePublishUIContext({
    label: 'Where to Watch',
    description: activeQuery
      ? `Searching for "${activeQuery}" on streaming services.`
      : 'Browsing popular titles on streaming services.',
  })

  // Popular is always cached (and pre-warmed by the app prefetcher → instant on open);
  // search runs only when there's an active query. The view shows one or the other.
  const popular = useQuery(whereToWatchPopularQueryOptions())
  const search = useQuery(whereToWatchSearchQueryOptions(activeQuery))

  const active = !!activeQuery
  const items: TitleCard[] = active ? (search.data ?? []) : (popular.data ?? [])
  const loading = active ? search.isLoading : popular.isLoading
  // "error" here means nothing to show (failed fetch or empty result), same UX as before.
  const status: 'loading' | 'ready' | 'error' = loading
    ? 'loading'
    : items.length > 0 ? 'ready' : 'error'

  const doSearch = useCallback((q: string) => {
    setActiveQuery(q.trim())
    setSelectedProvider('')
  }, [])

  const onSubmit = useCallback(() => { doSearch(query) }, [doSearch, query])
  useAppHeader({
    query,
    setQuery,
    onSubmit,
    placeholder: 'Search movies & shows...',
    loading: status === 'loading',
    externalHref: 'https://www.justwatch.com',
    settingsHref: '/apps/where-to-watch/settings',
  })

  const retry = useCallback(() => {
    if (activeQuery) void search.refetch()
    else void popular.refetch()
  }, [activeQuery, search, popular])

  // Collect unique provider names across all visible items
  const allProviders = Array.from(
    new Set(items.flatMap((c) => c.providers.map((p) => p.name))),
  )

  const visibleItems = selectedProvider
    ? items.filter((c) => c.providers.some((p) => p.name === selectedProvider))
    : items

  const sectionTitle = activeQuery
    ? `Results for "${activeQuery}"`
    : 'Popular Right Now'

  return (
    <PageShell>
      <PageContainer className="pb-10">
        <PageHeader />

        {/* Provider filter chips */}
        {status === 'ready' && (
          <FilterChips
            providers={allProviders}
            selected={selectedProvider}
            onSelect={setSelectedProvider}
          />
        )}

        {/* Section header */}
        <SectionHeader title={sectionTitle} className="pb-3" />

        {/* Loading */}
        {status === 'loading' && <SkeletonListRows count={6} />}

        {/* Error / empty */}
        {status === 'error' && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <WifiOff className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {activeQuery
                ? `Nothing found for "${activeQuery}".`
                : 'Could not load titles right now.'}
            </p>
            <button
              onClick={retry}
              className="text-xs text-brand hover:underline"
            >
              Try again
            </button>
          </div>
        )}

        {/* Grid */}
        {status === 'ready' && visibleItems.length > 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {visibleItems.map((card, i) => (
              <TitleCardItem key={`${card.title}-${i}`} card={card} />
            ))}
          </div>
        )}

        {/* Empty after filter */}
        {status === 'ready' && visibleItems.length === 0 && items.length > 0 && (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <Tv className="size-8 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">
              No titles found on {selectedProvider}.
            </p>
            <button
              onClick={() => setSelectedProvider('')}
              className="text-xs text-brand hover:underline"
            >
              Show all
            </button>
          </div>
        )}
      </PageContainer>
    </PageShell>
  )
}
