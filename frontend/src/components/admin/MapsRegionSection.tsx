/**
 * Map regions section — rendered inside AdminFeaturesTab under the Maps
 * feature group (mirrors ZimSection / "Content Packs" under Offline Library).
 *
 * The maps toolchain itself installs via the feature group's normal repair
 * flow (component `maps-toolchain`); this section just downloads/builds the
 * per-region map data once the toolchain is present. Each build streams phase
 * progress over SSE (download → streets → routing → geocoder).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, CheckCircle2, Download, Trash2 } from 'lucide-react'
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
  const [builds, setBuilds] = useState<Map<string, BuildState>>(new Map())
  const [open, setOpen] = useState(true)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const esRef = useRef<Map<string, EventSource>>(new Map())

  const loadCatalog = useCallback(() => {
    setLoading(true)
    fetch('/api/admin/maps/catalog', { credentials: 'include' })
      .then((r) => r.json())
      .then((d: { regions?: CatalogNode[] }) => setTree(d.regions ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadCatalog()
    const ref = esRef.current
    return () => { ref.forEach((es) => es.close()); ref.clear() }
  }, [loadCatalog])

  const setBuild = (regionId: string, next: BuildState | null) => {
    setBuilds((prev) => {
      const m = new Map(prev)
      if (next) m.set(regionId, next)
      else m.delete(regionId)
      return m
    })
  }

  function download(regionId: string) {
    setBuild(regionId, { status: 'pending', msg: 'Starting…' })
    const es = new EventSource(`/api/admin/maps/download/${regionId}`, { withCredentials: true })
    esRef.current.set(regionId, es)
    es.addEventListener('progress', (e) => {
      let p: { phase: string; msg?: string; pct?: number }
      try { p = JSON.parse((e as MessageEvent).data) } catch { return } // skip malformed frame
      const label = PHASE_LABEL[p.phase] ?? p.phase
      const detail = p.msg ?? label
      setBuild(regionId, {
        status: 'downloading',
        phase: p.phase,
        pct: typeof p.pct === 'number' ? p.pct : undefined,
        msg: p.pct != null ? `${label} ${p.pct}%` : detail,
      })
    })
    es.addEventListener('done', () => { es.close(); esRef.current.delete(regionId); setBuild(regionId, { status: 'completed' }); loadCatalog() })
    es.addEventListener('cancelled', () => { es.close(); esRef.current.delete(regionId); setBuild(regionId, null); loadCatalog() })
    es.addEventListener('error', (e) => {
      es.close(); esRef.current.delete(regionId)
      let msg = 'Build failed'
      try { if ('data' in e) msg = JSON.parse((e as MessageEvent).data).msg ?? msg } catch { /* ignore */ }
      setBuild(regionId, { status: 'error', error: msg })
    })
  }

  function cancel(regionId: string) {
    fetch(`/api/admin/maps/cancel/${regionId}`, { method: 'POST', credentials: 'include' }).catch(() => {})
    esRef.current.get(regionId)?.close()
    esRef.current.delete(regionId)
    setBuild(regionId, null)
  }

  async function remove(regionId: string) {
    await fetch(`/api/admin/maps/${regionId}`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
    setBuild(regionId, null)
    loadCatalog()
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
                        <Button type="button" variant="outline" size="sm" className="gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-brand/50 hover:bg-brand/5" onClick={() => download(node.region_id)}>
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
