import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Globe, Rss, Code, Package, HardDrive, CheckCircle2, Download } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import type { DataSource } from '@/components/shared/ServiceConsentCard'

export interface AppTool {
  id: string
  name: string
  description: string
  offline: boolean
  /** Core companion plumbing: hidden from store + ability toggles. */
  core: boolean
  enabled: boolean
  /** Companion may use this tool in chat (the app-settings ability toggle). */
  chatEnabled: boolean
  dataSources: DataSource[]
  /** Owning user feature: install/remove goes through /api/features/:featureId. */
  featureId?: string | null
}

/** The subset of tool fields the install/request modals actually render. Both
 *  {@link AppTool} and the store's `StoreApp` satisfy this, so either can be passed. */
export type InstallableTool = Pick<AppTool, 'id' | 'name' | 'description' | 'dataSources'> & Pick<Partial<AppTool>, 'featureId'>

interface Props {
  tool: InstallableTool | null
  open: boolean
  onClose: () => void
}

const SOURCE_META: Record<DataSource['type'], { label: string; icon: React.ComponentType<{ className?: string }>; chip: string }> = {
  api: { label: 'API',  icon: Globe,    chip: 'bg-info/15 text-info' },
  rss: { label: 'RSS',  icon: Rss,      chip: 'bg-warning/15 text-warning' },
  web: { label: 'Web',  icon: Code,     chip: 'bg-brand/15 text-brand' },
  cdn: { label: 'CDN',  icon: Package,  chip: 'bg-muted text-muted-foreground' },
}

function fmtGb(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

export function InstallDisclosureModal({ tool, open, onClose }: Props) {
  const queryClient = useQueryClient()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Feature-backed tools install through the orchestrator, which may download models
  // and components: show the aggregate size + disk headroom before the admin commits.
  const featureId = tool?.featureId ?? null
  const { data: featureInfo } = useQuery({
    queryKey: ['features'],
    queryFn: async () => {
      const r = await fetch('/api/features', { credentials: 'include' })
      if (!r.ok) throw new Error('features failed')
      return (await r.json()) as {
        features: { id: string; bytesRequired: number }[]
        disk: { freeBytes: number }
      }
    },
    enabled: open && !!featureId,
    staleTime: 30 * 1000,
  })
  const feature = featureInfo?.features.find((f) => f.id === featureId)

  async function handleInstall() {
    if (!tool) return
    setLoading(true)
    setError(null)
    try {
      const res = tool.featureId
        ? await fetch(`/api/features/${tool.featureId}/enable`, { method: 'POST', credentials: 'include' })
        : await fetch(`/api/tools/${tool.id}/enabled`, {
            method: 'PUT',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
          })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? 'Failed to install')
      }
      await queryClient.invalidateQueries({ queryKey: ['tools'] })
      await queryClient.invalidateQueries({ queryKey: ['features'] })
      onClose()
    } catch (err) {
      setError(err instanceof Error && err.message !== 'Failed to install' ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (!tool) return null

  const hasSources = tool.dataSources.length > 0

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !loading) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Install {tool.name}</DialogTitle>
          <DialogDescription>{tool.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {hasSources ? (
            <>
              <p className="text-sm font-medium text-foreground/80">
                This app connects to the following external services:
              </p>
              <div className="space-y-2 rounded-card border border-border/50 bg-muted/30 p-3">
                {tool.dataSources.map((src, i) => {
                  const meta = SOURCE_META[src.type]
                  const Icon = meta.icon
                  return (
                    <div key={i} className="flex items-start gap-2">
                      <span className={cn(
                        'mt-0.5 flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
                        meta.chip,
                      )}>
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
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                These services will receive requests from your device. Make sure you are comfortable with
                data leaving your local network and that your use complies with each service's terms.
              </p>
            </>
          ) : (
            <div className="flex items-start gap-3 rounded-card border border-border/50 bg-muted/30 p-3">
              <HardDrive className="mt-0.5 size-4 shrink-0 text-success" />
              <div>
                <p className="text-sm font-medium">Fully local</p>
                <p className="text-xs text-muted-foreground leading-snug">
                  This app runs entirely on your local hardware. No external connections are made.
                </p>
              </div>
            </div>
          )}

          {feature && feature.bytesRequired > 0 && (
            <div className="flex items-start gap-3 rounded-card border border-border/50 bg-muted/30 p-3">
              <Download className="mt-0.5 size-4 shrink-0 text-brand" />
              <div>
                <p className="text-sm font-medium">Downloads about {fmtGb(feature.bytesRequired)}</p>
                <p className="text-xs text-muted-foreground leading-snug">
                  Models and components install to this server in the background
                  {featureInfo?.disk.freeBytes ? ` (${fmtGb(featureInfo.disk.freeBytes)} free)` : ''}. You can keep using the app meanwhile.
                </p>
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleInstall}
            disabled={loading}
            className="gap-1.5"
          >
            <CheckCircle2 className="size-3.5" />
            {loading ? 'Installing...' : 'Install'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
