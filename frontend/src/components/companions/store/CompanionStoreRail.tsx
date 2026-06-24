import { NavLink } from 'react-router-dom'
import { Home, LayoutGrid, Shapes, Heart, Settings2, Lock, type LucideIcon } from 'lucide-react'
import { AppRailHeader } from '@/components/shared/AppRailHeader'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'

function RailLink({ to, icon: Icon, label, end, badge }: {
  to: string; icon: LucideIcon; label: string; end?: boolean; badge?: number
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
        isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <Icon className="size-[18px]" />
      <span className="flex-1">{label}</span>
      {badge != null && badge > 0 && (
        <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-bold text-brand">{badge}</span>
      )}
    </NavLink>
  )
}

/** Companion-store left rail, rendered alongside the global app sidebar. */
export function CompanionStoreRail({ favoritesCount }: { favoritesCount: number }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  return (
    <nav className="sticky top-0 hidden h-fit w-52 shrink-0 flex-col gap-1 self-start border-r border-border/40 px-3 py-5 lg:flex">
      <AppRailHeader
        title="Companions"
        description="Browse and select your AI companion."
        className="mb-4"
      />

      <RailLink to="/companions" icon={Home} label="Home" end />
      <RailLink to="/companions/browse" icon={LayoutGrid} label="Browse" />
      <RailLink to="/companions/categories" icon={Shapes} label="Categories" />

      <p className="mt-6 mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">Library</p>
      <RailLink to="/companions/favorites" icon={Heart} label="Favorites" badge={favoritesCount} />
      {isAdmin && (
        <NavLink to="/companions/studio"
          className={({ isActive }) => cn(
            'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
            isActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
          )}>
          <Settings2 className="size-[18px]" />
          <span className="flex-1">Studio</span>
          <Lock className="size-3 text-amber-500/70" />
        </NavLink>
      )}
    </nav>
  )
}
