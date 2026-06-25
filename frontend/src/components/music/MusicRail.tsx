import { NavLink, Link, useSearchParams, useLocation } from 'react-router-dom'
import { Home, Radio, Search, Disc3, Sparkles, Shuffle, Heart, ListMusic, History, Download, type LucideIcon } from 'lucide-react'
import { useRadio } from '@/context/RadioContext'
import { cn } from '@/lib/cn'
import { AppRailHeader } from '@/components/shared/AppRailHeader'

function RailLink({ to, icon: Icon, label, end }: { to: string; icon: LucideIcon; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
        isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}>
      <Icon className="size-[18px]" /> {label}
    </NavLink>
  )
}

/** A library sub-tab link that reflects ?tab= on the library route. */
function LibTab({ tab, icon: Icon, label }: { tab: string; icon: LucideIcon; label: string }) {
  const [params] = useSearchParams()
  const { pathname } = useLocation()
  const active = pathname.startsWith('/music/library') && (params.get('tab') ?? 'favorites') === tab
  return (
    <Link to={`/music/library?tab=${tab}`}
      className={cn('flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
      <Icon className="size-[18px]" /> {label}
    </Link>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 mt-5 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">{children}</p>
}

export function MusicRail() {
  const radio = useRadio()
  return (
    <nav className="hidden h-full min-h-0 w-60 shrink-0 flex-col overflow-y-auto overscroll-none border-r border-border/40 px-3 py-5 lg:flex">
      <AppRailHeader title="Music" className="mb-4" />
      <RailLink to="/music" icon={Home} label="Home" end />
      <RailLink to="/music/stations" icon={Radio} label="Stations" />
      <RailLink to="/music/browse" icon={Search} label="Browse" />
      {radio.active && <RailLink to="/music/now-playing" icon={Disc3} label="Now Playing" />}

      <SectionLabel>Create</SectionLabel>
      <RailLink to="/music/generate" icon={Sparkles} label="Generate" />
      <RailLink to="/music/remix" icon={Shuffle} label="Remix" />

      <SectionLabel>Your Library</SectionLabel>
      <LibTab tab="favorites" icon={Heart} label="Favorites" />
      <LibTab tab="playlists" icon={ListMusic} label="Playlists" />
      <LibTab tab="history" icon={History} label="History" />
      <LibTab tab="offline" icon={Download} label="Offline" />
    </nav>
  )
}
