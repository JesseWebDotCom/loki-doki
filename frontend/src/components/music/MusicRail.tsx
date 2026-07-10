import { NavLink, Link, useSearchParams, useLocation } from 'react-router-dom'
import { Home, Radio, RadioTower, Search, Disc3, Sparkles, Shuffle, SlidersHorizontal, Heart, ListMusic, History, Download, CalendarRange, Mic2, type LucideIcon } from 'lucide-react'
import { useRadio } from '@/context/RadioContext'
import { usePlayerOverlay } from '@/context/PlayerOverlayContext'
import { useMusicModeOptional } from '@/components/music/MusicLayout'
import { cn } from '@/lib/cn'
import { AppRailHeader } from '@/components/shared/AppRailHeader'

function RailLink({ to, icon: Icon, label, end }: { to: string; icon: LucideIcon; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors',
        isActive ? 'bg-brand/10 text-brand' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
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
      className={cn('flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-brand/10 text-brand' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}>
      <Icon className="size-[18px]" /> {label}
    </Link>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 mt-5 px-3 text-overline text-muted-foreground/60">{children}</p>
}

export function MusicRail({ variant = 'sidebar' }: { variant?: 'sidebar' | 'drawer' }) {
  const radio = useRadio()
  const { openPlayer } = usePlayerOverlay()
  const offline = useMusicModeOptional() === 'offline'
  const drawer = variant === 'drawer'
  return (
    <nav className={cn(
      'h-full min-h-0 shrink-0 flex-col overflow-y-auto overscroll-none px-3 py-5',
      drawer ? 'flex w-full' : 'hidden w-60 border-r border-border/40 lg:flex',
    )}>
      <AppRailHeader title="Music" className="mb-4" />
      <RailLink to="/music" icon={Home} label="Home" end />
      <RailLink to="/music/stations" icon={Radio} label="Stations" />
      <RailLink to="/music/browse" icon={Search} label="Browse" />
      {/* Live radio streams need the internet - hide it offline (recordings stay reachable
          via the library's Radio tab below). */}
      {!offline && <RailLink to="/music/live" icon={RadioTower} label="Live Radio" />}
      {/* Raises the full player overlay in place (no route change; the /music/now-playing
          deep link still works for external callers and does the same). */}
      {radio.active && (
        <button type="button" onClick={() => openPlayer()}
          className="flex items-center gap-3 rounded-control px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground">
          <Disc3 className="size-[18px]" /> Now Playing
        </button>
      )}

      {/* Create needs the internet (LLM + generators) - hide it offline. */}
      {!offline && <>
        <SectionLabel>Create</SectionLabel>
        <RailLink to="/music/generate" icon={Sparkles} label="Generate" />
        <RailLink to="/music/remix" icon={Shuffle} label="Remix" />
        <RailLink to="/music/studio" icon={SlidersHorizontal} label="Studio" />
        <RailLink to="/music/karaoke" icon={Mic2} label="Karaoke" />
      </>}

      <SectionLabel>Your Library</SectionLabel>
      <LibTab tab="favorites" icon={Heart} label="Favorites" />
      <LibTab tab="playlists" icon={ListMusic} label="Playlists" />
      <LibTab tab="history" icon={History} label="History" />
      <RailLink to="/music/replay" icon={CalendarRange} label="Replay" />
      <LibTab tab="radio" icon={RadioTower} label="Radio" />
      <LibTab tab="offline" icon={Download} label="Offline" />
    </nav>
  )
}
