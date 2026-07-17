import { ShieldCheck, Globe } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { cardVariants } from '@/components/ui/card'
import { AppIcon, ConnectivityBadge } from '@/components/store/AppIcon'
import { PrimaryAction } from '@/components/store/StoreActions'
import { SOURCE_META } from '@/components/shared/InstallDisclosureModal'
import type { StoreApp } from '@/lib/store/useStoreApps'

/** At-a-glance data-access summary so parents see what an app reaches before installing.
 *  "Fully local" when nothing leaves home, else the count plus the distinct source types. */
function AppSourceSummary({ app }: { app: StoreApp }) {
  const sources = app.dataSources ?? []
  if (sources.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-success">
        <ShieldCheck className="size-3.5" /> Fully local
      </span>
    )
  }
  const types = Array.from(new Set(sources.map(s => s.type)))
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-muted-foreground/80">
      <Globe className="size-3.5 shrink-0" />
      <span>{sources.length} {sources.length === 1 ? 'source' : 'sources'}</span>
      <span className="flex gap-1">
        {types.map(t => (
          <span key={t} className={cn('rounded px-1 py-px text-caption font-medium', SOURCE_META[t].chip)}>
            {SOURCE_META[t].label}
          </span>
        ))}
      </span>
    </span>
  )
}

/** Grid card linking to the detail page; primary action stops propagation. */
export function StoreAppCard({ app, className }: { app: StoreApp; className?: string }) {
  const navigate = useNavigate()
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/app-store/app/${app.id}`)}
      onKeyDown={e => { if (e.key === 'Enter') navigate(`/app-store/app/${app.id}`) }}
      className={cn(cardVariants({ variant: 'interactive' }), 'group flex flex-col gap-3 p-4 text-left', className)}
    >
      <div className="flex items-start justify-between">
        <AppIcon app={app} className="size-16" iconClassName="size-8" />
        <ConnectivityBadge app={app} className="mt-0.5" />
      </div>

      <div className="flex-1">
        <p className="text-sm font-semibold leading-snug">{app.name}</p>
        <p className="text-caption text-muted-foreground/70">{app.category}</p>
        <p className="mt-1 text-xs text-muted-foreground leading-relaxed line-clamp-2">{app.description}</p>
        <div className="mt-2"><AppSourceSummary app={app} /></div>
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
      className={cn(cardVariants({ variant: 'interactive' }), 'flex w-56 shrink-0 flex-col gap-3 p-4')}
    >
      <div className="flex items-center gap-3">
        <AppIcon app={app} className="size-12" iconClassName="size-6" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{app.name}</p>
          <p className="truncate text-caption text-muted-foreground/70">{app.category}</p>
        </div>
      </div>
      <PrimaryAction app={app} full />
    </div>
  )
}
