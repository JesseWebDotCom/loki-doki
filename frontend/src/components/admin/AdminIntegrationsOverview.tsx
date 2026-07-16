// The Integrations hub landing view: every external service as a status card, grouped
// by category. Cards navigate to the existing per-service detail views (which stay
// URL-addressable); services owned by an app also link out to that app's settings page,
// where the same shared config component is embedded.

import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { cardVariants } from '@/components/ui/card'
import { INTEGRATIONS, INTEGRATION_CATEGORIES, type IntegrationCategory, type IntegrationDef } from '@/lib/integrationsRegistry'
import { useIntegrationsStatus, type IntegrationStatusRow } from '@/hooks/useIntegrationsStatus'

const STATE_BADGE: Record<IntegrationStatusRow['state'], { label: string; variant: 'success' | 'secondary' | 'outline' | 'destructive' }> = {
  connected: { label: 'Connected', variant: 'success' },
  configured: { label: 'Configured', variant: 'secondary' },
  not_configured: { label: 'Not set up', variant: 'outline' },
  error: { label: 'Unreachable', variant: 'destructive' },
}

function IntegrationCard({ def, row, probing, onNavigate }: {
  def: IntegrationDef
  row: IntegrationStatusRow | undefined
  probing: boolean
  onNavigate: (section: string, sub?: string) => void
}) {
  const badge = row ? STATE_BADGE[row.state] : null
  const Icon = def.icon
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onNavigate('integrations', def.adminSub)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate('integrations', def.adminSub) } }}
      className={cn(cardVariants({ variant: 'interactive' }), 'flex flex-col gap-3 p-4')}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-control bg-foreground/8 text-foreground">
          <Icon className="size-4.5" />
        </div>
        {badge ? (
          <Badge variant={badge.variant}>{badge.label}</Badge>
        ) : (
          <Spinner />
        )}
      </div>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          {def.label}
          {probing && row?.state === 'configured' && <Spinner size="sm" />}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{def.blurb}</p>
      </div>
      <div className="mt-auto space-y-1">
        {row?.url && <p className="truncate text-xs text-muted-foreground">{row.url}{row.detail ? ` · ${row.detail}` : ''}</p>}
        {row?.state === 'error' && row.error && <p className="truncate text-xs text-destructive">{row.error}</p>}
        {def.appSettingsHref && def.ownerAppLabel && (
          <Link
            to={def.appSettingsHref}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
          >
            Managed in {def.ownerAppLabel} settings <ArrowUpRight className="size-3" />
          </Link>
        )}
      </div>
    </div>
  )
}

export function AdminIntegrationsOverview({ onNavigate }: { onNavigate: (section: string, sub?: string) => void }) {
  const cheap = useIntegrationsStatus(false)
  const probed = useIntegrationsStatus(true)
  const rows = probed.data?.rows ?? cheap.data?.rows ?? []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const probing = probed.isLoading

  const categories = (Object.keys(INTEGRATION_CATEGORIES) as IntegrationCategory[])
    .map((cat) => ({ cat, defs: INTEGRATIONS.filter((d) => d.category === cat) }))
    .filter((g) => g.defs.length)

  return (
    <div className="space-y-8 p-5">
      <p className="text-sm text-muted-foreground">
        Every external service in one place. Open a card for the full management view, or jump to the app that owns it.
      </p>
      {categories.map(({ cat, defs }) => (
        <section key={cat} className="space-y-3">
          <h3 className="text-lg font-bold tracking-tight">{INTEGRATION_CATEGORIES[cat]}</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {defs.map((def) => (
              <IntegrationCard key={def.id} def={def} row={byId.get(def.id)} probing={probing} onNavigate={onNavigate} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
