// Export dialog: pick a preset, watch the render job's real progress, then play or
// download the result (which also lands in the media bin as origin='export').

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Clapperboard, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import { getStudioExport, startStudioExport, studioStreamUrl } from '@/lib/videos/studioApi'

const PRESETS: Array<{ id: string; label: string; hint: string }> = [
  { id: '1080p', label: '1080p', hint: '1920×1080 · H.264 · best for sharing' },
  { id: '720p', label: '720p', hint: '1280×720 · smaller file' },
  { id: 'vertical', label: 'Vertical', hint: '1080×1920 · shorts style' },
  { id: 'draft', label: 'Draft', hint: '640×360 · fast check render' },
]

export function ExportDialog({ projectId, open, onClose }: {
  projectId: string
  open: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [preset, setPreset] = useState('1080p')
  const [exportId, setExportId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  useEffect(() => { if (!open) { setExportId(null); setStarting(false) } }, [open])

  const { data: status } = useQuery({
    queryKey: ['studio-export', exportId],
    queryFn: () => getStudioExport(exportId!),
    enabled: !!exportId,
    refetchInterval: (q) => {
      const s = q.state.data?.export.status
      return s === 'ready' || s === 'failed' ? false : 1500
    },
  })

  useEffect(() => {
    if (status?.export.status === 'ready') void qc.invalidateQueries({ queryKey: ['studio-bin'] })
  }, [status?.export.status, qc])

  async function start() {
    setStarting(true)
    try {
      const res = await startStudioExport(projectId, preset)
      setExportId(res.exportId)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the export')
    } finally {
      setStarting(false)
    }
  }

  const st = status?.export.status
  const pct = status?.progress?.total
    ? Math.min(100, Math.round(((status.progress.completed ?? 0) / status.progress.total) * 100))
    : null

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Clapperboard className="size-4" /> Export</DialogTitle>
        </DialogHeader>

        {!exportId ? (
          <div className="space-y-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                className={`flex w-full items-center justify-between rounded-control border p-3 text-left text-sm transition-colors ${
                  preset === p.id ? 'border-[var(--yt-accent)] bg-[var(--yt-accent-soft)]' : 'border-border hover:bg-accent/50'
                }`}
              >
                <span className="font-medium">{p.label}</span>
                <span className="text-xs text-muted-foreground">{p.hint}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="py-2">
            {st === 'ready' ? (
              <div className="flex flex-col items-center gap-3 py-4">
                <Check className="size-8 text-[var(--yt-accent-fg)]" />
                <p className="text-sm font-medium">Export finished</p>
                {status?.export.assetId && (
                  <Button asChild size="sm" className="gap-1.5">
                    <a href={studioStreamUrl(status.export.assetId)} download={`${status.export.title}.mp4`}>
                      <Download className="size-4" /> Download MP4
                    </a>
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">Also saved to your media bin.</p>
              </div>
            ) : st === 'failed' ? (
              <p className="py-4 text-sm text-destructive">{status?.export.error ?? 'Render failed.'}</p>
            ) : (
              <div className="flex flex-col items-center gap-3 py-4">
                <Spinner />
                <p className="text-sm text-muted-foreground">
                  {status?.progress?.note ?? 'Rendering…'}{pct != null ? ` ${pct}%` : ''}
                </p>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-[var(--yt-accent)] transition-all" style={{ width: `${pct ?? 4}%` }} />
                </div>
                <p className="text-xs text-muted-foreground">Safe to close: the render continues in the background.</p>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {!exportId ? (
            <>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={() => void start()} disabled={starting} className="gap-1.5">
                {starting ? <Spinner size="sm" className="text-primary-foreground" /> : <Clapperboard className="size-4" />}
                Export {PRESETS.find((p) => p.id === preset)?.label}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={onClose}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
