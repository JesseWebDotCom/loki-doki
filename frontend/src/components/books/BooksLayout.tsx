import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Archive, BookAudio, Compass, Library, Upload } from 'lucide-react'
import { AppRailHeader } from '@/components/shared/AppRailHeader'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { cn } from '@/lib/cn'

function RailLink({ to, icon: Icon, label, end }: { to: string; icon: typeof Library; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium transition-colors',
        isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}>
      <Icon className="size-[18px]" />
      {label}
    </NavLink>
  )
}

export function BooksLayout() {
  usePublishUIContext({ label: 'Books', description: 'User is browsing the Books app (EPUBs, offline libraries, audiobooks).' })

  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const [query, setQuery] = useState(params.get('q') ?? '')

  // Keep the search box in sync with the URL query on the Book Store route.
  const urlQ = params.get('q') ?? ''
  useEffect(() => {
    if (pathname === '/books') setQuery(urlQ)
  }, [pathname, urlQ])

  useAppHeader({
    query,
    setQuery,
    onSubmit: () => { const t = query.trim(); if (t) navigate(`/books?q=${encodeURIComponent(t)}`) },
    placeholder: 'Search books…',
  })

  return (
    <div className="flex min-h-full bg-background">
      <nav className="sticky top-0 hidden h-fit w-56 shrink-0 flex-col gap-1 self-start border-r border-border/40 px-3 py-5 lg:flex">
        <AppRailHeader title="Books" className="mb-4" />
        <RailLink to="/books" icon={Compass} label="Book Store" end />
        <RailLink to="/books/audiobooks" icon={BookAudio} label="Audiobook Store" />
        <RailLink to="/books/library" icon={Library} label="My Library" />
        <RailLink to="/books/archives" icon={Archive} label="Offline Archives" />
        <RailLink to="/books/upload" icon={Upload} label="Upload" />
      </nav>

      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
