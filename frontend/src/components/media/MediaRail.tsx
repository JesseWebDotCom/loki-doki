import { NavLink, useLocation } from 'react-router-dom'
import {
  Compass, Ticket, CalendarClock, Trophy, Shapes, Bookmark, Tv, CalendarDays, Play, Baby, type LucideIcon,
} from 'lucide-react'
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 mt-5 px-3 text-overline text-muted-foreground/60">{children}</p>
}

/** Left rail for the Movies / Shows cinema shell (same posture as MusicRail/VideosRail).
 *  The rail swaps with the app: Movies (theatrical discovery) vs Shows (TV discovery). */
export function MediaRail({ variant = 'sidebar' }: { variant?: 'sidebar' | 'drawer' }) {
  const { pathname } = useLocation()
  const movies = pathname.startsWith('/movies')
  const drawer = variant === 'drawer'
  return (
    <nav className={cn(
      'h-full min-h-0 shrink-0 flex-col overflow-y-auto overscroll-none px-3 py-5',
      drawer ? 'flex w-full' : 'hidden w-60 border-r border-border/40 lg:flex',
    )}>
      <AppRailHeader title={movies ? 'Movies' : 'Shows'} className="mb-4" />
      {movies ? (
        <>
          <RailLink to="/movies" icon={Compass} label="Discover" end />
          <RailLink to="/movies/in-theaters" icon={Ticket} label="In Theaters" />
          <RailLink to="/movies/new" icon={CalendarClock} label="New Releases" />
          <RailLink to="/movies/top-rated" icon={Trophy} label="Top Rated" />
          <RailLink to="/movies/genres" icon={Shapes} label="Genres" />
          <RailLink to="/movies/family" icon={Baby} label="Family" />
          <SectionLabel>Your Stuff</SectionLabel>
          <RailLink to="/movies/watchlist" icon={Bookmark} label="Watchlist" />
        </>
      ) : (
        <>
          <RailLink to="/shows" icon={Compass} label="Discover" end />
          <RailLink to="/shows/on-tv" icon={Tv} label="On TV Tonight" />
          <RailLink to="/shows/calendar" icon={CalendarDays} label="Calendar" />
          <RailLink to="/shows/top-rated" icon={Trophy} label="Top Rated" />
          <RailLink to="/shows/genres" icon={Shapes} label="Genres" />
          <RailLink to="/shows/family" icon={Baby} label="Family" />
          <SectionLabel>Your Stuff</SectionLabel>
          <RailLink to="/shows/continue" icon={Play} label="Continue Watching" />
          <RailLink to="/shows/watchlist" icon={Bookmark} label="Watchlist" />
        </>
      )}
    </nav>
  )
}
