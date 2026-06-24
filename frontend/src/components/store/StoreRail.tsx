import { NavLink } from 'react-router-dom'
import { Home, LayoutGrid, Shapes, Sparkles, DownloadCloud, Inbox, type LucideIcon } from 'lucide-react'
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
        isActive
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
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

/** Store-specific left rail, rendered alongside the global app sidebar. */
export function StoreRail({ installedCount }: { installedCount: number }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  return (
    <nav className="sticky top-0 hidden h-fit w-52 shrink-0 flex-col gap-1 self-start border-r border-border/40 px-3 py-5 lg:flex">
      <div className="mb-4 flex items-start gap-2.5 px-2">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-brand text-brand-foreground shadow-sm">
          <Sparkles className="size-4" />
        </span>
        <div>
          <p className="text-base font-bold leading-tight tracking-tight">App Store</p>
          <p className="text-[11px] leading-snug text-muted-foreground">Install apps and extensions for your hub.</p>
        </div>
      </div>

      <RailLink to="/app-store" icon={Home} label="Home" end />
      <RailLink to="/app-store/browse" icon={LayoutGrid} label="Browse" />
      <RailLink to="/app-store/categories" icon={Shapes} label="Categories" />

      <p className="mt-6 mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">Library</p>
      <RailLink to="/app-store/installed" icon={DownloadCloud} label="Installed" badge={installedCount} />
      {isAdmin && <RailLink to="/admin/apps" icon={Inbox} label="Requests" />}
    </nav>
  )
}
