import { NavLink, Link } from 'react-router-dom'
import { Home, Compass, Library, Download, Plus, Settings2, Lock, type LucideIcon } from 'lucide-react'
import { AppRailHeader } from '@/components/shared/AppRailHeader'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import { ShowCover } from '@/components/podcast/ShowCover'
import type { Show } from '@/lib/podcast/api'

function RailLink({ to, icon: Icon, label, end }: { to: string; icon: LucideIcon; label: string; end?: boolean }) {
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

export function PodcastRail({ shows, onCreate }: { shows: Show[]; onCreate: () => void }) {
  const { user } = useAuth()
  const myShows = shows.filter(s => s.isOwn)
  return (
    <nav className="sticky top-0 hidden h-fit w-56 shrink-0 flex-col gap-1 self-start border-r border-border/40 px-3 py-5 lg:flex">
      <AppRailHeader
        title="Podcasts"
        className="mb-4"
      />

      <RailLink to="/podcasts" icon={Home} label="Listen Now" end />
      <RailLink to="/podcasts/browse" icon={Compass} label="Browse" />
      <RailLink to="/podcasts/library" icon={Library} label="Library" />
      <RailLink to="/podcasts/offline" icon={Download} label="Offline" />
      {user?.role === 'admin' && (
        <NavLink to="/podcasts/admin"
          className={({ isActive }) => cn(
            'flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium transition-colors',
            isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}>
          <Settings2 className="size-[18px]" />
          <span className="flex-1">Manage</span>
          <Lock className="size-3 text-warning/70" />
        </NavLink>
      )}

      <Button variant="tinted" onClick={onCreate}
        className="mt-2 h-auto w-full justify-start gap-3 rounded-control px-3 py-2.5 text-sm font-semibold">
        <Plus className="size-[18px]" /> Create New
      </Button>

      {myShows.length > 0 && (
        <>
          <p className="mb-1 mt-6 px-3 text-overline text-muted-foreground/50">Your Shows</p>
          <div className="space-y-0.5">
            {myShows.slice(0, 8).map(s => (
              <Link key={s.id} to={`/podcasts/show/${s.id}`}
                className="flex items-center gap-2.5 rounded-control px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
                <ShowCover showId={s.id} title={s.name} size={28} rounded="rounded-control" />
                <span className="truncate">{s.name}</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </nav>
  )
}
