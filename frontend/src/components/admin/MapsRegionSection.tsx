/**
 * Map regions section — rendered inside AdminFeaturesTab under the Maps
 * feature group (mirrors ZimSection / "Content Packs" under Offline Library).
 *
 * The maps toolchain itself installs via the feature group's normal repair
 * flow (component `maps-toolchain`); this section just downloads/builds the
 * per-region map data once the toolchain is present. Each build streams phase
 * progress over SSE (download → streets → routing → geocoder).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, CheckCircle2, Download, Trash2 } from 'lucide-react'
import { useSetupProgress } from '@/context/SetupProgressContext'
import { DownloadProgress, type DownloadStatus } from '@/components/shared/DownloadProgress'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'

interface CatalogNode {
  region_id: string
  label: string
  parent_id: string | null
  sizes_mb: { street: number; valhalla: number; pbf: number }
  downloadable: boolean
  installed: boolean
  install_status: string | null
  children: CatalogNode[]
}

interface BuildState {
  status: DownloadStatus
  phase?: string
  msg?: string
  pct?: number
  error?: string
}

const PHASE_LABEL: Record<string, string> = {
  resolving: 'Preparing…',
  downloading: 'Downloading map data…',
  building_streets: 'Building vector tiles…',
  building_terrain: 'Downloading terrain…',
  building_landcover: 'Sampling satellite landcover…',
  building_routing: 'Building routing graph…',
  building_geocoder: 'Indexing places…',
  ready: 'Finishing…',
}

function flatten(nodes: CatalogNode[], depth = 0): { node: CatalogNode; depth: number }[] {
  const out: { node: CatalogNode; depth: number }[] = []
  for (const node of nodes) {
    out.push({ node, depth })
    if (node.children?.length) out.push(...flatten(node.children, depth + 1))
  }
  return out
}

function qMatch(text: string, q: string): boolean {
  return text.toLowerCase().includes(q.toLowerCase())
}

export function MapsRegionSection({ toolchainInstalled, query }: { toolchainInstalled: boolean; query: string }) {
  const [tree, setTree] = useState<CatalogNode[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(true)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  // Builds run in the shared background queue so they persist across navigation and surface in the
  // global download widget. `queued` is optimistic feedback until the poller reflects the new job.
  const { status: jobsStatus, cancelJob: cancelQueuedJob, refresh: refreshJobs } = useSetupProgress()
  const [queued, setQueued] = useState<Set<string>>(new Set())

  const loadCatalog = useCallback(() => {
    setLoading(true)
    fetch('/api/admin/maps/catalog', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { regions?: CatalogNode[] }) => setTree(d.regions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { loadCatalog() }, [loadCatalog])

  // Map build jobs from the background queue, keyed by regionId (= job.refId).
  const mapJobs = useMemo(
    () => new Map((jobsStatus?.jobs ?? []).filter(j => j.type === 'map').map(j => [j.refId, j] as const)),
    [jobsStatus],
  )

  // Per-region build state derived from the queue, plus optimistic entries for just-clicked rows.
  // Map jobs report phase progress as { completed: pct, total: 100, note: phaseLabel }.
  const builds = useMemo(() => {
    const m = new Map<string, BuildState>()
    for (const [refId, j] of mapJobs) {
      const p = j.progress
      const status: DownloadStatus =
        j.status === 'completed' ? 'completed'
        : j.status === 'failed' ? 'error'
        : j.status === 'cancelled' ? 'cancelled'
        : j.status === 'pending' ? 'pending'
        : 'downloading'  // running
      m.set(refId, {
        status,
        pct: p && p.total > 0 ? Math.round((p.completed / p.total) * 100) : undefined,
        msg: p?.note ?? (j.status === 'pending' ? 'Queued…' : undefined),
        error: j.lastError ?? undefined,
      })
    }
    for (const rid of queued) {
      if (!m.has(rid)) m.set(rid, { status: 'pending', msg: 'Queued…' })
    }
    return m
  }, [mapJobs, queued])

  // Drop optimistic entries once the queue has picked them up.
  useEffect(() => {
    if (!queued.size) return
    const settled = [...queued].filter(rid => mapJobs.has(rid))
    if (settled.length) setQueued(prev => { const n = new Set(prev); for (const s of settled) n.delete(s); return n })
  }, [mapJobs, queued])

  // Enqueue into the background queue instead of a foreground SSE build; `force` re-runs a region
  // whose prior build already completed (Update / re-add after delete).
  async function download(regionId: string, label: string) {
    setQueued(prev => new Set(prev).add(regionId))
    try {
      await fetch('/api/jobs/enqueue', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maps: { regionId, label }, force: true }),
      })
    } catch { /* optimistic entry stays; the poller reconciles */ }
    refreshJobs()
  }

  function cancel(regionId: string) {
    setQueued(prev => { const n = new Set(prev); n.delete(regionId); return n })
    const job = mapJobs.get(regionId)
    if (job) void cancelQueuedJob(job.id)
  }

  async function remove(regionId: string) {
    await fetch(`/api/admin/maps/${regionId}`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
    loadCatalog()
    refreshJobs()
  }

  const rows = flatten(tree)
  const visible = query ? rows.filter(({ node }) => qMatch(node.label, query)) : rows
  const installedCount = rows.filter(({ node }) => node.installed).length
  const effectiveOpen = query ? visible.length > 0 : open

  if (query && visible.length === 0) return null

  return (
    <div className="space-y-2 pl-4 border-l border-border/30">
      <button
        type="button"
        onClick={() => !query && setOpen((o) => !o)}
        className={cn('flex w-full items-center gap-2 px-1', !toolchainInstalled && 'opacity-40 pointer-events-none')}
      >
        <ChevronDown className={cn('size-3 text-muted-foreground/50 transition-transform', !effectiveOpen && '-rotate-90')} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">Map Regions</span>
        {installedCount > 0 && (
          <span className="text-[10px] text-muted-foreground/40 tabular-nums">{installedCount} installed</span>
        )}
      </button>

      {effectiveOpen && toolchainInstalled && (
        <div className="space-y-2">
          {loading ? (
            <div className="flex items-center gap-2 px-1 py-2">
              <Spinner size="sm" className="text-muted-foreground/50" />
              <span className="text-xs text-muted-foreground/50">Loading…</span>
            </div>
          ) : visible.map(({ node, depth }) => {
            if (!node.downloadable) {
              // Continent / parent rows act as headers only.
              return (
                <p
                  key={node.region_id}
                  className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50"
                  style={{ marginLeft: depth * 12 }}
                >
                  {node.label}
                </p>
              )
            }
            const build = builds.get(node.region_id)
            const isActive = build?.status === 'downloading' || build?.status === 'pending'
            const status: DownloadStatus = build?.status ?? (node.installed ? 'completed' : 'idle')
            return (
              <Card key={node.region_id} variant="surface" className="border-border" style={{ marginLeft: depth * 12 }}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <div className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full',
                    node.installed ? 'bg-success/15' : 'bg-muted',
                  )}>
                    {node.installed
                      ? <CheckCircle2 className="size-3 text-success" />
                      : <div className="size-1.5 rounded-full bg-muted-foreground/30" />}
                  </div>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold leading-tight">{node.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-snug line-clamp-1">
                      ~{node.sizes_mb.street} MB tiles, ~{node.sizes_mb.valhalla} MB routing
                    </p>
                  </div>

                  <div className="shrink-0 flex items-center gap-1">
                    {isActive ? (
                      <Button type="button" variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => cancel(node.region_id)}>
                        Cancel
                      </Button>
                    ) : (
                      <>
                        {node.installed && (
                          <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={() => setConfirmRemoveId(node.region_id)} aria-label="Remove region">
                            <Trash2 className="size-3" />
                          </Button>
                        )}
                        <Button type="button" variant="outline" size="sm" className="gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-brand/50 hover:bg-brand/5" onClick={() => download(node.region_id, node.label)}>
                          <Download className="size-3" />
                          {node.installed ? 'Update' : 'Add'}
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {build && build.status !== 'cancelled' && build.status !== 'idle' && (
                  <div className="border-t border-border/50 px-4 pb-3 pt-2">
                    <DownloadProgress
                      label={node.label}
                      description={isActive ? (build.msg ?? (build.phase ? PHASE_LABEL[build.phase] : undefined)) : undefined}
                      status={status}
                      progress={isActive ? build.pct : undefined}
                      error={build.error}
                      onCancel={isActive ? () => cancel(node.region_id) : undefined}
                    />
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemoveId !== null}
        onOpenChange={open => !open && setConfirmRemoveId(null)}
        title="Remove map region?"
        description="This will delete all downloaded map tiles and routing data for this region. You can re-download it at any time."
        confirmLabel="Remove"
        destructive
        onConfirm={() => { if (confirmRemoveId) { void remove(confirmRemoveId); setConfirmRemoveId(null) } }}
      />
    </div>
  )
}
