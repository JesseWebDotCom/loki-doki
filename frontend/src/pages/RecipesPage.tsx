import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  RefreshCw,
  UtensilsCrossed,
  WifiOff,
  PlayCircle,
} from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { cn } from '@/lib/cn'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useBreadcrumbSearch } from '@/context/BreadcrumbSearchContext'

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
    <div className="rounded-2xl border border-border/60 bg-card overflow-hidden">
      {meal.image && (
        <img
          src={meal.image}
          alt={meal.name}
          className="w-full object-cover max-h-64"
        />
      )}
      <div className="p-5 space-y-4">
        <div className="space-y-2">
          <h2 className="text-2xl font-black leading-tight">{meal.name}</h2>
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
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Ingredients
            </p>
            <div className="grid grid-cols-2 gap-1">
              {meal.ingredients.map((ing, i) => (
                <span
                  key={i}
                  className="rounded-lg bg-muted/60 px-2.5 py-1 text-xs leading-snug"
                >
                  {ing}
                </span>
              ))}
            </div>
          </div>
        )}

        {meal.instructions && (
          <div>
            <button
              onClick={() => setInstrOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm font-semibold transition-colors hover:bg-muted/60"
            >
              Instructions
              {instrOpen
                ? <ChevronUp className="size-4 text-muted-foreground" />
                : <ChevronDown className="size-4 text-muted-foreground" />
              }
            </button>
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium transition-colors hover:border-brand/40 hover:text-brand"
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10"
            >
              <PlayCircle className="size-3.5" />
              Watch on YouTube
            </a>
          )}
          <button
            onClick={onShuffle}
            disabled={shuffling}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 active:scale-95 disabled:opacity-50 ml-auto"
          >
            <RefreshCw className={cn('size-3.5', shuffling && 'animate-spin')} />
            Shuffle
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Search result card ────────────────────────────────────────────────────────

function SearchCard({ meal, onSelect }: { meal: Meal; onSelect: (meal: Meal) => void }) {
  return (
    <button
      onClick={() => onSelect(meal)}
      className="group flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card text-left transition-all hover:border-brand/40 hover:shadow-md active:scale-[0.98]"
    >
      {meal.image && (
        <img
          src={meal.image}
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
  useBreadcrumbSearch({
    query,
    setQuery,
    onSubmit,
    placeholder: 'Search recipes...',
    loading: searchStatus === 'loading',
    externalHref: 'https://www.themealdb.com',
    settingsHref: '/admin/features?tool=recipes',
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
    <PageShell gradient="linear-gradient(135deg,#7c2d12,#ea580c)" GhostIcon={UtensilsCrossed}>
      <div className="flex items-center justify-between px-5 pt-5 pb-2 shrink-0">
        <h1 className="text-xl font-black tracking-tight">Recipes</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-8 space-y-6 sm:px-5">

        {/* Hero card */}
        {heroStatus === 'loading' && !hero && (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
          </div>
        )}

        {heroStatus === 'error' && !hero && (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-border/60 bg-card py-16 text-center">
            <WifiOff className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Couldn't load a recipe right now.</p>
            <button
              onClick={() => void loadRandom()}
              className="flex items-center gap-1.5 text-xs text-brand hover:underline"
            >
              <RefreshCw className="size-3" /> Try again
            </button>
          </div>
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
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
            </p>
            <div className="grid grid-cols-2 gap-3">
              {searchResults.map((m) => (
                <SearchCard key={m.id} meal={m} onSelect={handleSelectResult} />
              ))}
            </div>
          </div>
        )}
      </div>
    </PageShell>
  )
}
