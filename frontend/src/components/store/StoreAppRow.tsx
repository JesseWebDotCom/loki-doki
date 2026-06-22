import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { AppIcon } from '@/components/store/AppIcon'
import { PrimaryAction, SecondaryActions } from '@/components/store/StoreActions'
import type { StoreApp } from '@/lib/store/useStoreApps'

/** List row used in category "All apps" and Browse list view. */
export function StoreAppRow({ app, className }: { app: StoreApp; className?: string }) {
  const navigate = useNavigate()
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/app-store/app/${app.id}`)}
      onKeyDown={e => { if (e.key === 'Enter') navigate(`/app-store/app/${app.id}`) }}
      className={cn(
        'flex cursor-pointer items-center gap-4 rounded-2xl border border-transparent px-3 py-2.5',
        'transition-colors hover:border-border/60 hover:bg-accent/40',
        className,
      )}
    >
      <AppIcon app={app} className="size-12" iconClassName="size-6" rounded="rounded-xl" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{app.name}</p>
        <p className="truncate text-xs text-muted-foreground">{app.description}</p>
      </div>

      <span className="hidden w-24 shrink-0 text-right text-xs font-medium text-muted-foreground/70 sm:block">
        {app.offline ? 'Extension' : 'App'}
      </span>

      <div className="flex shrink-0 items-center gap-1">
        <PrimaryAction app={app} />
        <SecondaryActions app={app} />
      </div>
    </div>
  )
}
