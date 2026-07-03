import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Check, MoreHorizontal, Trash2, ExternalLink, Info } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { InstallDisclosureModal } from '@/components/shared/InstallDisclosureModal'
import { RequestModal } from '@/components/store/RequestModal'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/cn'
import type { StoreApp } from '@/lib/store/useStoreApps'

interface StoreActionsValue {
  isAdmin: boolean
  busyId: string | null
  /** Open the install disclosure modal (admin). */
  install: (app: StoreApp) => void
  /** Open the request modal (non-admin). */
  request: (app: StoreApp) => void
  /** Disable / uninstall a tool-backed app (admin). */
  remove: (app: StoreApp) => Promise<void>
  /** Navigate to the app's real page. */
  open: (app: StoreApp) => void
  /** Navigate to the store detail page. */
  details: (app: StoreApp) => void
}

const StoreActionsContext = createContext<StoreActionsValue | null>(null)

export function useStoreActions(): StoreActionsValue {
  const ctx = useContext(StoreActionsContext)
  if (!ctx) throw new Error('useStoreActions must be used within StoreActionsProvider')
  return ctx
}

export function StoreActionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [installTarget, setInstallTarget] = useState<StoreApp | null>(null)
  const [requestTarget, setRequestTarget] = useState<StoreApp | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const remove = useCallback(async (app: StoreApp) => {
    setBusyId(app.id)
    try {
      await fetch(`/api/tools/${app.id}/enabled`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
      await qc.invalidateQueries({ queryKey: ['tools'] })
    } finally { setBusyId(null) }
  }, [qc])

  const value: StoreActionsValue = {
    isAdmin,
    busyId,
    install: setInstallTarget,
    request: setRequestTarget,
    remove,
    open: app => { if (app.route) navigate(app.route) },
    details: app => navigate(`/app-store/app/${app.id}`),
  }

  return (
    <StoreActionsContext.Provider value={value}>
      {children}
      <InstallDisclosureModal
        tool={installTarget}
        open={installTarget !== null}
        onClose={() => setInstallTarget(null)}
      />
      <RequestModal
        tool={requestTarget}
        open={requestTarget !== null}
        onClose={() => setRequestTarget(null)}
      />
    </StoreActionsContext.Provider>
  )
}

// ── Presentational primary action button ───────────────────────────────────────

type ActionSize = 'sm' | 'md'

/**
 * The single most relevant action for an app, matching the store's design language.
 * Installed+page → Open; installed (admin, tool) → Installed pill; not installed →
 * Get (admin) / Request (user). `stop` prevents card-link navigation.
 */
export function PrimaryAction({ app, size = 'sm', full, className }: {
  app: StoreApp; size?: ActionSize; full?: boolean; className?: string
}) {
  const { isAdmin, busyId, install, request, open } = useStoreActions()
  const busy = busyId === app.id
  const btnSize = size === 'sm' ? 'sm' : 'default'
  const cls = cn(full && 'w-full', className)
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  if (app.enabled) {
    if (app.route) {
      return (
        <Button size={btnSize} onClick={e => { stop(e); open(app) }}
          className={cn('bg-foreground text-background hover:bg-foreground/90', cls)}>
          <ExternalLink className="size-3.5" /> Open
        </Button>
      )
    }
    return (
      <span className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-full bg-success/15 font-semibold text-success cursor-default',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-9 px-4 text-sm',
        cls,
      )}>
        <Check className="size-3.5" /> Installed
      </span>
    )
  }

  if (isAdmin) {
    return (
      <Button size={btnSize} onClick={e => { stop(e); install(app) }} disabled={busy} className={cls}>
        {busy ? <Spinner size="sm" className="text-primary-foreground" /> : null} Get
      </Button>
    )
  }
  return (
    <Button variant="secondary" size={btnSize} onClick={e => { stop(e); request(app) }} className={cls}>
      Request
    </Button>
  )
}

/** Kebab menu with Details / Open / Remove, used on list rows and detail hero. */
export function SecondaryActions({ app, className }: { app: StoreApp; className?: string }) {
  const { isAdmin, remove, open, details } = useStoreActions()
  const canRemove = isAdmin && app.enabled && !app.builtIn
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="More actions"
          onClick={e => e.stopPropagation()}
          className={cn('size-8 text-muted-foreground hover:text-foreground', className)}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={e => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => details(app)}>
          <Info className="size-4" /> View details
        </DropdownMenuItem>
        {app.enabled && app.route && (
          <DropdownMenuItem onSelect={() => open(app)}>
            <ExternalLink className="size-4" /> Open
          </DropdownMenuItem>
        )}
        {canRemove && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void remove(app)}>
              <Trash2 className="size-4" /> Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
