import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { AppIcon, ConnectivityBadge } from '@/components/store/AppIcon'
import { PrimaryAction } from '@/components/store/StoreActions'
import type { StoreApp } from '@/lib/store/useStoreApps'

/** Grid card linking to the detail page; primary action stops propagation. */
export function StoreAppCard({ app, className }: { app: StoreApp; className?: string }) {
  const navigate = useNavigate()
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/app-store/app/${app.id}`)}
      onKeyDown={e => { if (e.key === 'Enter') navigate(`/app-store/app/${app.id}`) }}
      className={cn(
        'group flex flex-col gap-3 rounded-2xl border border-border/40 bg-card p-4 text-left',
        'cursor-pointer transition-colors hover:bg-accent/40 hover:border-border',
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <AppIcon app={app} className="size-16" iconClassName="size-8" />
        <ConnectivityBadge app={app} className="mt-0.5" />
      </div>

      <div className="flex-1">
        <p className="text-sm font-bold leading-snug">{app.name}</p>
        <p className="text-[11px] font-medium text-muted-foreground/70">{app.category}</p>
        <p className="mt-1 text-xs text-muted-foreground leading-relaxed line-clamp-2">{app.description}</p>
      </div>

      <div className="mt-auto pt-0.5">
        <PrimaryAction app={app} full />
      </div>
    </div>
  )
}

/** Compact horizontal-scroll card (Recommended row on the home page). */
export function StoreAppMiniCard({ app }: { app: StoreApp }) {
  const navigate = useNavigate()
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/app-store/app/${app.id}`)}
      onKeyDown={e => { if (e.key === 'Enter') navigate(`/app-store/app/${app.id}`) }}
      className="flex w-56 shrink-0 cursor-pointer flex-col gap-3 rounded-2xl border border-border/40 bg-card p-4 transition-colors hover:bg-accent/40 hover:border-border"
    >
      <div className="flex items-center gap-3">
        <AppIcon app={app} className="size-12" iconClassName="size-6" />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold">{app.name}</p>
          <p className="truncate text-[11px] text-muted-foreground/70">{app.category}</p>
        </div>
      </div>
      <PrimaryAction app={app} full />
    </div>
  )
}
