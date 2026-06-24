import { useEffect, useMemo, useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { useCompanionStore } from '@/lib/companions/useCompanionStore'
import { CompanionStoreRail } from '@/components/companions/store/CompanionStoreRail'

/** Back/forward history nav — lives in the breadcrumb's left slot. */
function NavButtons() {
  const navigate = useNavigate()
  return (
    <div className="flex shrink-0 gap-1">
      <button onClick={() => navigate(-1)} className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Back">
        <ArrowLeft className="size-4" />
      </button>
      <button onClick={() => navigate(1)} className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Forward">
        <ArrowRight className="size-4" />
      </button>
    </div>
  )
}

/** Persistent shell for every /companions view: own rail + outlet.
 *  Search + history nav live in the global breadcrumb bar (like YouTube/Reader). */
export function CompanionStoreLayout() {
  const { favorites } = useCompanionStore()
  const navigate = useNavigate()
  const location = useLocation()
  const onBrowse = location.pathname === '/companions/browse'
  const [query, setQuery] = useState(onBrowse ? new URLSearchParams(location.search).get('q') ?? '' : '')

  usePublishUIContext({ label: 'Companions', description: 'User is browsing the Companion store.' })

  // Keep the box in sync with the URL while on Browse (search results live there).
  useEffect(() => {
    if (onBrowse) setQuery(new URLSearchParams(location.search).get('q') ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, onBrowse])

  // Live-filter: typing routes to Browse with a debounced query param.
  useEffect(() => {
    const q = query.trim()
    if (!q && !onBrowse) return
    const t = setTimeout(() => {
      navigate(`/companions/browse${q ? `?q=${encodeURIComponent(q)}` : ''}`, { replace: onBrowse })
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const leftSlot = useMemo(() => <NavButtons />, [])
  useAppHeader({
    query,
    setQuery,
    placeholder: 'Search companions by name, vibe, or category…',
    leftSlot,
  })

  return (
    <div className="flex min-h-full bg-background">
      <CompanionStoreRail favoritesCount={favorites.length} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
