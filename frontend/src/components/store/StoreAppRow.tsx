import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { AppIcon } from '@/components/store/AppIcon'
import { PrimaryAction, SecondaryActions } from '@/components/store/StoreActions'
import type { StoreApp } from '@/lib/store/useStoreApps'

/** List row used in category "All apps" and Browse list view. Mirrors the shared
 *  ListRow geometry (kept hand-rolled: the row hosts nested action buttons). */
export function StoreAppRow({ app, className }: { app: StoreApp; className?: string }) {
  const navigate = useNavigate()
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/app-store/app/${app.id}`)}
      onKeyDown={e => { if (e.key === 'Enter') navigate(`/app-store/app/${app.id}`) }}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-control px-3 py-2.5',
        'transition-colors hover:bg-foreground/[0.04] active:bg-foreground/[0.07]',
        className,
      )}
    >
      <AppIcon app={app} className="size-10" iconClassName="size-5" rounded="rounded-control" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{app.name}</p>
        <p className="truncate text-caption text-muted-foreground">{app.description}</p>
      </div>

      <span className="hidden w-24 shrink-0 text-right text-caption text-muted-foreground/70 sm:block">
        {app.offline ? 'Extension' : 'App'}
      </span>

      <div className="flex shrink-0 items-center gap-1">
        <PrimaryAction app={app} />
        <SecondaryActions app={app} />
      </div>
    </div>
  )
}
