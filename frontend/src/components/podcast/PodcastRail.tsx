import { NavLink, Link } from 'react-router-dom'
import { Mic, Home, Compass, Library, Plus, Settings2, Lock, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import { ShowCover } from '@/components/podcast/ShowCover'
import type { Show } from '@/lib/podcast/api'

function RailLink({ to, icon: Icon, label, end }: { to: string; icon: LucideIcon; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
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
      <div className="mb-4 flex items-start gap-2.5 px-2">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-foreground shadow-sm">
          <Mic className="size-4" />
        </span>
        <div>
          <p className="text-base font-bold leading-tight tracking-tight">Podcasts</p>
          <p className="text-[11px] leading-snug text-muted-foreground">AI-produced shows from any series or film.</p>
        </div>
      </div>

      <RailLink to="/podcasts" icon={Home} label="Listen Now" end />
      <RailLink to="/podcasts/browse" icon={Compass} label="Browse" />
      <RailLink to="/podcasts/library" icon={Library} label="Library" />
      {user?.role === 'admin' && (
        <NavLink to="/podcasts/admin"
          className={({ isActive }) => cn(
            'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
            isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}>
          <Settings2 className="size-[18px]" />
          <span className="flex-1">Manage</span>
          <Lock className="size-3 text-amber-500/70" />
        </NavLink>
      )}

      <button onClick={onCreate}
        className="mt-2 flex items-center gap-3 rounded-xl bg-brand/10 px-3 py-2.5 text-sm font-semibold text-brand transition-colors hover:bg-brand/15">
        <Plus className="size-[18px]" /> Create New
      </button>

      {myShows.length > 0 && (
        <>
          <p className="mb-1 mt-6 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">Your Shows</p>
          <div className="space-y-0.5">
            {myShows.slice(0, 8).map(s => (
              <Link key={s.id} to={`/podcasts/show/${s.id}`}
                className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
                <ShowCover showId={s.id} title={s.name} size={28} rounded="rounded-md" />
                <span className="truncate">{s.name}</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </nav>
  )
}
