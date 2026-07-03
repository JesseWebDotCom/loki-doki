import { Wifi, Cpu } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { StoreApp } from '@/lib/store/useStoreApps'

/** Consistent gradient icon tile for an app, used across every store surface. */
export function AppIcon({ app, className, iconClassName, rounded = 'rounded-card' }: {
  app: StoreApp
  className?: string
  iconClassName?: string
  rounded?: string
}) {
  const Icon = app.icon
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center shadow-md',
        rounded,
        app.gradient ? '' : `bg-gradient-to-br ${app.colorClass ?? 'from-brand to-brand/60'}`,
        className ?? 'size-14',
      )}
      style={app.gradient ? { backgroundImage: app.gradient } : undefined}
    >
      <Icon className={cn('text-white drop-shadow-sm', iconClassName ?? 'size-7')} />
    </div>
  )
}

/** Small online/offline connectivity badge. */
export function ConnectivityBadge({ app, className }: { app: StoreApp; className?: string }) {
  return (
    <span
      className={cn(
        'flex items-center justify-center size-6 rounded-full shadow-sm',
        app.online ? 'bg-info text-info-foreground' : 'bg-muted text-muted-foreground',
        className,
      )}
      title={app.online ? 'Connects to the internet' : 'Runs locally'}
    >
      {app.online ? <Wifi className="size-3" /> : <Cpu className="size-3" />}
    </span>
  )
}
