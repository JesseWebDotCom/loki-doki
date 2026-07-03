import { Globe, Rss, Code, Package } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface DataSource {
  name: string
  domain: string
  purpose: string
  type: 'api' | 'rss' | 'web' | 'cdn'
}

export interface ServiceConsentCardProps {
  name: string
  description?: string
  icon?: React.ReactNode
  dataSources: DataSource[]
  className?: string
}

const TYPE_META: Record<DataSource['type'], { label: string; icon: React.ComponentType<{ className?: string }>; chip: string }> = {
  api: { label: 'API',  icon: Globe, chip: 'bg-info/15 text-info' },
  rss: { label: 'RSS',  icon: Rss,   chip: 'bg-warning/15 text-warning' },
  web: { label: 'Web',  icon: Code,  chip: 'bg-brand/15 text-brand' },
  cdn: { label: 'CDN',  icon: Package, chip: 'bg-muted text-muted-foreground' },
}

export function ServiceConsentCard({ name, description, icon, dataSources, className }: ServiceConsentCardProps) {
  return (
    <div className={cn('rounded-card border border-border/60 bg-card/60 p-3 space-y-2.5', className)}>
      <div className="flex items-start gap-2.5">
        {icon && (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-control bg-muted text-muted-foreground">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight">{name}</p>
          {description && <p className="mt-0.5 text-xs text-muted-foreground leading-snug">{description}</p>}
        </div>
      </div>

      {dataSources.length > 0 && (
        <div className="space-y-1.5 pl-1">
          {dataSources.map((src, i) => {
            const meta = TYPE_META[src.type]
            const Icon = meta.icon
            return (
              <div key={i} className="flex items-start gap-2">
                <span className={cn('mt-0.5 flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none', meta.chip)}>
                  <Icon className="size-2.5" />
                  {meta.label}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium leading-tight text-foreground/80">{src.domain}</p>
                  <p className="text-[11px] text-muted-foreground leading-snug">{src.purpose}</p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Standard footer shown on every consent prompt. Pluralizes based on source count. */
export function ConsentWarningFooter({ sourceCount }: { sourceCount: number }) {
  const plural = sourceCount !== 1
  return (
    <p className="text-xs text-muted-foreground leading-relaxed border-t border-border/50 pt-3 mt-1">
      {plural
        ? 'These features retrieve content from external sources over the internet. Make sure you trust these sources, that you\'re comfortable with data leaving your local network, and that your use complies with each service\'s terms. Requests are made directly from your device to these sources.'
        : 'This feature retrieves content from an external source over the internet. Make sure you trust the source, that you\'re comfortable with the data leaving your local network, and that your use complies with that service\'s terms. Requests are made directly from your device to this source.'}
    </p>
  )
}
