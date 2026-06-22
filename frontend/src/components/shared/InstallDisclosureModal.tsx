import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Globe, Rss, Code, Package, HardDrive, CheckCircle2 } from 'lucide-react'
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
  enabled: boolean
  dataSources: DataSource[]
}

interface Props {
  tool: AppTool | null
  open: boolean
  onClose: () => void
}

const SOURCE_META: Record<DataSource['type'], { label: string; icon: React.ComponentType<{ className?: string }>; chip: string }> = {
  api: { label: 'API',  icon: Globe,    chip: 'bg-sky-500/15 text-sky-400' },
  rss: { label: 'RSS',  icon: Rss,      chip: 'bg-orange-500/15 text-orange-400' },
  web: { label: 'Web',  icon: Code,     chip: 'bg-amber-500/15 text-amber-500' },
  cdn: { label: 'CDN',  icon: Package,  chip: 'bg-slate-500/15 text-slate-400' },
}

export function InstallDisclosureModal({ tool, open, onClose }: Props) {
  const queryClient = useQueryClient()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleInstall() {
    if (!tool) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/tools/${tool.id}/enabled`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
      if (!res.ok) throw new Error('Failed to install')
      await queryClient.invalidateQueries({ queryKey: ['tools'] })
      onClose()
    } catch {
      setError('Something went wrong. Please try again.')
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
              <div className="space-y-2 rounded-xl border border-border/50 bg-muted/30 p-3">
                {tool.dataSources.map((src, i) => {
                  const meta = SOURCE_META[src.type]
                  const Icon = meta.icon
                  return (
                    <div key={i} className="flex items-start gap-2">
                      <span className={cn(
                        'mt-0.5 flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-none',
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
            <div className="flex items-start gap-3 rounded-xl border border-border/50 bg-muted/30 p-3">
              <HardDrive className="mt-0.5 size-4 shrink-0 text-emerald-500" />
              <div>
                <p className="text-sm font-medium">Fully local</p>
                <p className="text-xs text-muted-foreground leading-snug">
                  This app runs entirely on your local hardware. No external connections are made.
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
