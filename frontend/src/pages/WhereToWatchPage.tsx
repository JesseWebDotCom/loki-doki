import { useCallback, useEffect, useState } from 'react'
import { Film, Loader2, Tv, WifiOff } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { cn } from '@/lib/cn'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useBreadcrumbSearch } from '@/context/BreadcrumbSearchContext'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Provider {
  name: string
  offerType: string
  label: string
  url: string
}

interface TitleCard {
  title: string
  year: number | null
  objectType: string
  posterUrl: string
  justwatchUrl: string
  providers: Provider[]
}

interface BrowseResponse {
  mode: 'popular' | 'new'
  found: boolean
  items: TitleCard[]
  error?: string
}

interface LookupResponse {
  mode: 'lookup'
  found: boolean
  title?: string
  year?: number | null
  posterUrl?: string
  justwatchUrl?: string
  providers?: Provider[]
  error?: string
}

type ApiResponse = BrowseResponse | LookupResponse

const GRADIENT = 'linear-gradient(135deg,#1e1b4b,#7c3aed)'

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchPopular(country = 'US'): Promise<TitleCard[]> {
  const r = await fetch(
    `/api/where-to-watch?mode=popular&country=${encodeURIComponent(country)}`,
    { credentials: 'include' },
  )
  if (!r.ok) return []
  const d = (await r.json()) as BrowseResponse
  return d.items ?? []
}

async function fetchSearch(q: string, country = 'US'): Promise<TitleCard[]> {
  const r = await fetch(
    `/api/where-to-watch?q=${encodeURIComponent(q)}&country=${encodeURIComponent(country)}`,
    { credentials: 'include' },
  )
  if (!r.ok) return []
  const d = (await r.json()) as ApiResponse
  if (d.mode === 'lookup') {
    if (!d.found || !d.title) return []
    const lookup = d as LookupResponse
    return [
      {
        title: lookup.title!,
        year: lookup.year ?? null,
        objectType: '',
        posterUrl: lookup.posterUrl ?? '',
        justwatchUrl: lookup.justwatchUrl ?? '',
        providers: lookup.providers ?? [],
      },
    ]
  }
  return (d as BrowseResponse).items ?? []
}

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
      <div className="relative size-16 shrink-0 overflow-hidden rounded-lg bg-muted/60">
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
        className="group block rounded-2xl border border-border/60 bg-card transition-all hover:border-brand/40 hover:shadow-md active:scale-[0.99]"
      >
        {inner}
      </a>
    )
  }

  return (
    <div className="rounded-2xl border border-border/60 bg-card">
      {inner}
    </div>
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
    <div className="flex flex-wrap gap-1.5 px-5 pb-3">
      {['All', ...providers].map((p) => (
        <button
          key={p}
          onClick={() => onSelect(p === 'All' ? '' : p)}
          className={cn(
            'rounded-full px-3 py-1 text-xs font-semibold transition-colors',
            (p === 'All' && !selected) || selected === p
              ? 'bg-brand text-white'
              : 'bg-muted text-muted-foreground hover:bg-muted/80',
          )}
        >
          {p}
        </button>
      ))}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function WhereToWatchPage() {
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [items, setItems] = useState<TitleCard[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [selectedProvider, setSelectedProvider] = useState('')

  usePublishUIContext({
    label: 'Where to Watch',
    description: activeQuery
      ? `Searching for "${activeQuery}" on streaming services.`
      : 'Browsing popular titles on streaming services.',
  })

  const loadPopular = useCallback(async () => {
    setStatus('loading')
    setItems([])
    setSelectedProvider('')
    try {
      const data = await fetchPopular()
      setItems(data)
      setStatus(data.length ? 'ready' : 'error')
    } catch {
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void loadPopular()
  }, [loadPopular])

  const doSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) {
      setActiveQuery('')
      setSelectedProvider('')
      void loadPopular()
      return
    }
    setActiveQuery(trimmed)
    setStatus('loading')
    setItems([])
    setSelectedProvider('')
    try {
      const data = await fetchSearch(trimmed)
      setItems(data)
      setStatus(data.length ? 'ready' : 'error')
    } catch {
      setStatus('error')
    }
  }, [loadPopular])

  const onSubmit = useCallback(() => { void doSearch(query) }, [doSearch, query])
  useBreadcrumbSearch({
    query,
    setQuery,
    onSubmit,
    placeholder: 'Search movies & shows...',
    loading: status === 'loading',
    externalHref: 'https://www.justwatch.com',
    settingsHref: '/admin/features?tool=where-to-watch',
  })

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
    <PageShell gradient={GRADIENT} GhostIcon={Tv}>
      <PageHeader
        variant="compact"
        title="Where to Watch"
        gradient={GRADIENT}
        icon={<Tv className="size-7 text-white" />}
      />

      {/* Provider filter chips */}
      {status === 'ready' && (
        <FilterChips
          providers={allProviders}
          selected={selectedProvider}
          onSelect={setSelectedProvider}
        />
      )}

      {/* Section header */}
      {status !== 'idle' && (
        <div className="px-5 pb-3">
          <SectionHeader title={sectionTitle} />
        </div>
      )}

      {/* Loading */}
      {status === 'loading' && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

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
            onClick={() => (activeQuery ? void doSearch(activeQuery) : void loadPopular())}
            className="text-xs text-brand hover:underline"
          >
            Try again
          </button>
        </div>
      )}

      {/* Grid */}
      {status === 'ready' && visibleItems.length > 0 && (
        <div className="px-4 pb-10 sm:px-5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {visibleItems.map((card, i) => (
              <TitleCardItem key={`${card.title}-${i}`} card={card} />
            ))}
          </div>
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
    </PageShell>
  )
}
