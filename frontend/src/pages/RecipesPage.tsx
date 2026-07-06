import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  RefreshCw,
  WifiOff,
  PlayCircle,
} from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Button } from '@/components/ui/button'
import { Card, cardVariants } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'

interface Meal {
  id: string
  name: string
  category: string
  area: string
  image: string
  instructions: string
  ingredients: string[]
  source: string
  youtube: string
}

async function fetchRandom(): Promise<Meal> {
  const r = await fetch('/api/recipes/random', { credentials: 'include' })
  if (!r.ok) throw new Error(`Error ${r.status}`)
  return r.json() as Promise<Meal>
}

async function fetchSearch(q: string): Promise<Meal[]> {
  const r = await fetch(`/api/recipes/search?q=${encodeURIComponent(q)}`, { credentials: 'include' })
  if (!r.ok) throw new Error(`Error ${r.status}`)
  const d = (await r.json()) as { meals: Meal[] }
  return d.meals ?? []
}

// ── Hero card ─────────────────────────────────────────────────────────────────

function HeroCard({ meal, onShuffle, shuffling }: { meal: Meal; onShuffle: () => void; shuffling: boolean }) {
  const [instrOpen, setInstrOpen] = useState(false)

  useEffect(() => { setInstrOpen(false) }, [meal.id])

  return (
    <Card>
      {meal.image && (
        <img
          src={proxyImg(meal.image)}
          alt={meal.name}
          className="w-full object-cover max-h-64"
        />
      )}
      <div className="p-5 space-y-4">
        <div className="space-y-2">
          <h2 className="text-title leading-tight">{meal.name}</h2>
          <div className="flex flex-wrap gap-1.5">
            {meal.area && (
              <span className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                {meal.area}
              </span>
            )}
            {meal.category && (
              <span className="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                {meal.category}
              </span>
            )}
          </div>
        </div>

        {meal.ingredients.length > 0 && (
          <div>
            <p className="mb-2 text-overline text-muted-foreground">
              Ingredients
            </p>
            <div className="grid grid-cols-2 gap-1">
              {meal.ingredients.map((ing, i) => (
                <span
                  key={i}
                  className="rounded-control bg-muted/60 px-2.5 py-1 text-xs leading-snug"
                >
                  {ing}
                </span>
              ))}
            </div>
          </div>
        )}

        {meal.instructions && (
          <div>
            <Button
              variant="outline"
              onClick={() => setInstrOpen((v) => !v)}
              className="w-full justify-between rounded-control bg-muted/40 px-3 font-semibold hover:bg-muted/60"
            >
              Instructions
              {instrOpen
                ? <ChevronUp className="size-4 text-muted-foreground" />
                : <ChevronDown className="size-4 text-muted-foreground" />
              }
            </Button>
            {instrOpen && (
              <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                {meal.instructions}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {meal.source && (
            <a
              href={meal.source}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-3 py-1.5 text-xs font-medium transition-colors hover:border-brand/40 hover:text-brand"
            >
              <ExternalLink className="size-3.5" />
              View Original
            </a>
          )}
          {meal.youtube && (
            <a
              href={meal.youtube}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
            >
              <PlayCircle className="size-3.5" />
              Watch on YouTube
            </a>
          )}
          <Button
            size="sm"
            onClick={onShuffle}
            disabled={shuffling}
            className="ml-auto"
          >
            {shuffling ? <Spinner size="sm" className="text-primary-foreground" /> : <RefreshCw className="size-3.5" />}
            Shuffle
          </Button>
        </div>
      </div>
    </Card>
  )
}

// ── Search result card ────────────────────────────────────────────────────────

function SearchCard({ meal, onSelect }: { meal: Meal; onSelect: (meal: Meal) => void }) {
  return (
    <button
      onClick={() => onSelect(meal)}
      className={cn(cardVariants({ variant: 'interactive' }), 'group flex flex-col text-left')}
    >
      {meal.image && (
        <img
          src={proxyImg(meal.image)}
          alt={meal.name}
          className="w-full aspect-video object-cover"
        />
      )}
      <div className="flex flex-col gap-1 p-3">
        <p className="text-sm font-semibold leading-snug line-clamp-2">{meal.name}</p>
        {meal.category && (
          <span className="self-start rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {meal.category}
          </span>
        )}
      </div>
    </button>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function RecipesPage() {
  const [hero, setHero] = useState<Meal | null>(null)
  const [heroStatus, setHeroStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [shuffling, setShuffling] = useState(false)

  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<Meal[] | null>(null)
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading' | 'empty' | 'ready' | 'error'>('idle')

  usePublishUIContext({
    label: 'Recipes',
    description: hero
      ? `User is browsing recipes. Currently viewing: ${hero.name} (${hero.area} ${hero.category}).`
      : 'User is on the Recipes page.',
  })

  const loadRandom = useCallback(async () => {
    setShuffling(true)
    if (!hero) setHeroStatus('loading')
    try {
      const meal = await fetchRandom()
      setHero(meal)
      setHeroStatus('ready')
    } catch {
      setHeroStatus('error')
    } finally {
      setShuffling(false)
    }
  }, [hero])

  useEffect(() => {
    void loadRandom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) {
      setSearchResults(null)
      setSearchStatus('idle')
      return
    }
    setSearchStatus('loading')
    setSearchResults(null)
    try {
      const meals = await fetchSearch(trimmed)
      setSearchResults(meals)
      setSearchStatus(meals.length ? 'ready' : 'empty')
    } catch {
      setSearchStatus('error')
    }
  }, [])

  const onSubmit = useCallback(() => { void handleSearch(query) }, [handleSearch, query])
  useAppHeader({
    query,
    setQuery,
    onSubmit,
    placeholder: 'Search recipes...',
    loading: searchStatus === 'loading',
    externalHref: 'https://www.themealdb.com',
    settingsHref: '/apps/recipes/settings',
  })

  const handleSelectResult = (meal: Meal) => {
    setHero(meal)
    setHeroStatus('ready')
    setSearchResults(null)
    setSearchStatus('idle')
    setQuery('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <PageShell>
      <PageContainer className="shrink-0">
        <PageHeader subtitle="AI-suggested meals with ingredients and step-by-step instructions." />
      </PageContainer>

      <div className="flex-1 overflow-y-auto">
        <PageContainer className="pb-8 space-y-6">

          {/* Hero card */}
          {heroStatus === 'loading' && !hero && (
            <Card>
              <Skeleton className="h-56 w-full rounded-none" />
              <div className="space-y-3 p-5">
                <Skeleton className="h-6 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </Card>
          )}

          {heroStatus === 'error' && !hero && (
            <Card className="flex flex-col items-center gap-3 py-16 text-center">
              <WifiOff className="size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Couldn't load a recipe right now.</p>
              <button
                onClick={() => void loadRandom()}
                className="flex items-center gap-1.5 text-xs text-brand hover:underline"
              >
                <RefreshCw className="size-3" /> Try again
              </button>
            </Card>
          )}

          {hero && heroStatus !== 'loading' && (
            <HeroCard meal={hero} onShuffle={() => void loadRandom()} shuffling={shuffling} />
          )}

          {/* Search results */}
          {searchStatus === 'empty' && (
            <p className="py-4 text-center text-sm text-muted-foreground">No recipes found for "{query}".</p>
          )}

          {searchStatus === 'error' && (
            <p className="py-4 text-center text-sm text-destructive">Search failed. Check your connection.</p>
          )}

          {searchStatus === 'ready' && searchResults && searchResults.length > 0 && (
            <div className="space-y-3">
              <SectionHeader title="Results" count={searchResults.length} />
              <div className="grid grid-cols-2 gap-3">
                {searchResults.map((m) => (
                  <SearchCard key={m.id} meal={m} onSelect={handleSelectResult} />
                ))}
              </div>
            </div>
          )}
        </PageContainer>
      </div>
    </PageShell>
  )
}
