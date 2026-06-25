import { useEffect, useRef, useState } from 'react'
import { Outlet, useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { MusicRail } from '@/components/music/MusicRail'

/** Nested Music sub-app shell: persistent left rail + scrolling content pane, with a
 *  breadcrumb search box that routes to Browse. Mirrors the YouTube layout. */
export function MusicLayout() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const [query, setQuery] = useState(params.get('q') ?? '')

  usePublishUIContext({ label: 'Music', description: 'User is browsing the Music app.' })

  // Reset the scroller to the top on every route change.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => { scrollRef.current?.scrollTo(0, 0) }, [pathname])

  // Keep the search box in sync with the URL query on the Browse route.
  const urlQ = params.get('q') ?? ''
  useEffect(() => {
    if (pathname.startsWith('/music/browse')) setQuery(urlQ)
  }, [pathname, urlQ])

  useAppHeader({
    query,
    setQuery,
    onSubmit: () => { const t = query.trim(); if (t) navigate(`/music/browse?q=${encodeURIComponent(t)}`) },
    placeholder: 'Search artists, albums, songs…',
  })

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
      <MusicRail />
      <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none pb-28 md:pb-32">
        <Outlet />
      </div>
    </div>
  )
}
