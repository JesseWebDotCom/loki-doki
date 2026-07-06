import { NavLink } from 'react-router-dom'
import { Home, LayoutGrid, Shapes, ShoppingBag, DownloadCloud, Inbox, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import { AppRailHeader } from '@/components/shared/AppRailHeader'

/** App Store identity gradient. The store isn't an APP_GROUPS entry, so its identity
 *  lives here (matches the AppShell breadcrumb's STANDALONE_META entry).
 *  design-ok(hex-in-tsx): identity gradient data for an app outside the registry */
export const STORE_GRADIENT = 'linear-gradient(135deg,#4338ca,#6366f1)'

function RailLink({ to, icon: Icon, label, end, badge }: {
  to: string; icon: LucideIcon; label: string; end?: boolean; badge?: number
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => cn(
        'flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium transition-colors',
        isActive
          ? 'bg-brand/10 text-brand'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <Icon className="size-[18px]" />
      <span className="flex-1">{label}</span>
      {badge != null && badge > 0 && (
        <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand">{badge}</span>
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
      <AppRailHeader
        title="App Store"
        description="Install apps for your hub."
        icon={ShoppingBag}
        gradient={STORE_GRADIENT}
        className="mb-4"
      />

      <RailLink to="/app-store" icon={Home} label="Home" end />
      <RailLink to="/app-store/browse" icon={LayoutGrid} label="Browse" />
      <RailLink to="/app-store/categories" icon={Shapes} label="Categories" />

      <p className="mt-6 mb-1 px-3 text-overline text-muted-foreground/70">Library</p>
      <RailLink to="/app-store/installed" icon={DownloadCloud} label="Installed" badge={installedCount} />
      {isAdmin && <RailLink to="/admin/apps" icon={Inbox} label="Requests" />}
    </nav>
  )
}
