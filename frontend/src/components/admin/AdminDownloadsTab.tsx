// Admin → Integrations → Sonarr / Radarr / Overseerr / SABnzbd. Each product gets its
// own page: connection (URL + API key + test), then only that product's concerns:
// arr pages add download defaults, the request pipeline and per-user grants, and that
// arr's activity; the Overseerr page owns the pipeline choice and Plex attribution;
// the SABnzbd page owns the live queue, controls, and history.

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, History, Pause, Play, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { toast } from '@/lib/toast'
import {
  RequestGrantsList, useIntegrationsConfig, saveIntegrationsConfig, testIntegrations,
  type IntegrationsConfig, type TestResult,
} from '@/components/media/MediaIntegrations'

const opts: RequestInit = { credentials: 'include' }

export type MediaService = 'sonarr' | 'radarr' | 'overseerr' | 'sabnzbd'

const SERVICE_META: Record<MediaService, { label: string; urlKey: string; keyKey: string; setKey: keyof IntegrationsConfig; blurb: string }> = {
  sonarr: {
    label: 'Sonarr', urlKey: 'sonarr_url', keyKey: 'sonarr_key', setKey: 'sonarr_key_set',
    blurb: 'TV show downloads. Powers show requests from the Shows app and the library calendar.',
  },
  radarr: {
    label: 'Radarr', urlKey: 'radarr_url', keyKey: 'radarr_key', setKey: 'radarr_key_set',
    blurb: 'Movie downloads. Powers movie requests from the Movies app and the release calendar.',
  },
  overseerr: {
    label: 'Overseerr', urlKey: 'overseerr_url', keyKey: 'overseerr_key', setKey: 'overseerr_key_set',
    blurb: 'Request management. Requests are filed as each user’s linked Plex account, so Overseerr enforces its own permissions and quotas.',
  },
  sabnzbd: {
    label: 'SABnzbd', urlKey: 'sabnzbd_url', keyKey: 'sabnzbd_key', setKey: 'sabnzbd_key_set',
    blurb: 'Usenet download client. Powers the live queue below, the Downloads home widget, and download progress on requested titles.',
  },
}

// ── Connection card (one product) ─────────────────────────────────────────────────────

function ConnectionCard({ service }: { service: MediaService }) {
  const meta = SERVICE_META[service]
  const { data, refetch } = useIntegrationsConfig()
  const [url, setUrl] = useState<string | null>(null)
  const [key, setKey] = useState('')          // write-only; blank keeps the stored key
  const [test, setTest] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)

  const savedUrl = (data as unknown as Record<string, string>)?.[meta.urlKey] ?? ''
  const keySet = !!data?.[meta.setKey]

  const save = async () => {
    const ok = await saveIntegrationsConfig({
      [meta.urlKey]: url ?? savedUrl,
      ...(key.trim() ? { [meta.keyKey]: key.trim() } : {}),
    })
    if (ok) {
      toast.success(`${meta.label} saved`)
      setKey('')
      void refetch()
    } else toast.error(`Could not save ${meta.label}`)
  }

  const runTest = async () => {
    setTesting(true)
    const result = await testIntegrations()
    setTesting(false)
    if (result) setTest(result)
    else toast.error('Could not reach the server to test the connection')
  }

  const probe = test?.[service]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect {meta.label}</CardTitle>
        <CardDescription>{meta.blurb} Find the API key in {meta.label} under Settings → General.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* name+autoComplete stop the browser treating "text field next to a password
              field" as a login form and autofilling the admin username/password. */}
          <Input
            value={url ?? savedUrl}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://host:port"
            className="w-72"
            name={`${service}-server-url`}
            autoComplete="off"
          />
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={keySet ? 'API key saved' : 'API key'}
            className="w-52"
            name={`${service}-api-key`}
            autoComplete="new-password"
          />
          {probe ? (
            probe.ok ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-semibold text-success">
                <CheckCircle2 className="size-3" /> Connected{probe.version ? ` · v${probe.version}` : ''}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive">
                <XCircle className="size-3" /> Unreachable
              </span>
            )
          ) : keySet ? <CheckCircle2 className="size-4 text-success" /> : null}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => void save()}>Save</Button>
          <Button type="button" variant="ghost" onClick={() => void runTest()} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Arr defaults (quality profile + root folder, direct mode) ────────────────────────

function ArrDefaultsCard({ service }: { service: 'sonarr' | 'radarr' }) {
  const { data, refetch } = useIntegrationsConfig()
  const [test, setTest] = useState<TestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const profileKey = `${service}_quality_profile_id`
  const rootKey = `${service}_root_folder`
  const cfg = data as unknown as Record<string, string> | undefined
  const probe = test?.[service]

  const loadChoices = async () => {
    setLoading(true)
    const result = await testIntegrations()
    setLoading(false)
    if (result?.[service].ok) setTest(result)
    else toast.error(`Could not load choices: ${SERVICE_META[service].label} is unreachable`)
  }

  const saveValue = async (k: string, v: string) => {
    if (await saveIntegrationsConfig({ [k]: v })) void refetch()
    else toast.error('Could not save')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Download defaults</CardTitle>
        <CardDescription>
          Quality profile and folder used when a request adds a title in direct mode. Leave unset to use {SERVICE_META[service].label}&rsquo;s first profile and root folder.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <select
          className="ld-input w-48"
          value={cfg?.[profileKey] ?? ''}
          onChange={(e) => void saveValue(profileKey, e.target.value)}
        >
          <option value="">Quality: first profile</option>
          {(probe?.qualityProfiles ?? []).map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
        </select>
        <select
          className="ld-input w-60"
          value={cfg?.[rootKey] ?? ''}
          onChange={(e) => void saveValue(rootKey, e.target.value)}
        >
          <option value="">Folder: first root folder</option>
          {(probe?.rootFolders ?? []).map((f) => <option key={f.id} value={f.path}>{f.path}</option>)}
        </select>
        {!probe && (
          <Button type="button" variant="ghost" size="sm" onClick={() => void loadChoices()} disabled={loading}>
            {loading ? 'Loading…' : 'Load choices'}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// ── Request pipeline (shared decision; shown on the pages it affects) ─────────────────

function RequestPipelineCard({ service }: { service: MediaService }) {
  const { data, refetch } = useIntegrationsConfig()
  const pipeline = data?.request_pipeline ?? 'overseerr'

  const setPipeline = async (value: string) => {
    if (await saveIntegrationsConfig({ request_pipeline: value })) {
      toast.success(value === 'direct' ? 'Requests now go direct to Radarr and Sonarr' : 'Requests now go through Overseerr')
      void refetch()
    } else toast.error('Could not save')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Requests</CardTitle>
        <CardDescription>
          How the Request button in Shows and Movies (and the companion) files a request. This setting is shared across Sonarr, Radarr, and Overseerr.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <select className="ld-input w-96 max-w-full" value={pipeline} onChange={(e) => void setPipeline(e.target.value)}>
          <option value="overseerr">Through Overseerr (uses each user&rsquo;s linked Plex account)</option>
          <option value="direct">Direct to Radarr and Sonarr</option>
        </select>
        {pipeline === 'overseerr' && service === 'overseerr' && (
          <p className="text-xs text-muted-foreground">
            Users without a linked Plex account cannot request. Overseerr applies its own per-user permissions and quotas.
          </p>
        )}
        {pipeline === 'direct' && <RequestGrantsList />}
      </CardContent>
    </Card>
  )
}

// ── Arr activity (grabs/imports for one arr) ─────────────────────────────────────────

interface ArrQueueItem { arr: 'radarr' | 'sonarr'; title: string; status: string; progress: number; timeLeft: string | null }
interface SabSlot { nzoId: string; filename: string; percentage: number; mb: number; mbLeft: number; timeLeft: string; status: string }
interface SabHistoryItem { nzoId: string; name: string; status: string; failMessage: string | null; size: string; completedAt: number | null }
interface DownloadsPayload {
  sab: { paused: boolean; speed: string; sizeLeft: string; slots: SabSlot[]; history: SabHistoryItem[] } | null
  arr: ArrQueueItem[]
}

function useDownloads() {
  return useQuery({
    queryKey: ['admin-downloads'],
    queryFn: async () => {
      const r = await fetch('/api/media-integrations/downloads', opts)
      if (!r.ok) throw new Error('load failed')
      return (await r.json()) as DownloadsPayload
    },
    refetchInterval: 5_000,
  })
}

function ArrActivityCard({ service }: { service: 'sonarr' | 'radarr' }) {
  const { data } = useDownloads()
  const items = (data?.arr ?? []).filter((q) => q.arr === service)
  if (!items.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>Grabs and imports currently tracked by {SERVICE_META[service].label}.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((q, i) => (
          <div key={`${q.title}-${i}`} className="flex items-center gap-3 rounded-card border border-border/50 bg-card/40 p-3">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{q.title}</p>
            <span className="shrink-0 text-xs text-muted-foreground">
              {q.status}{q.progress ? ` · ${q.progress}%` : ''}{q.timeLeft ? ` · ${q.timeLeft} left` : ''}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

// ── SABnzbd queue manager + history ───────────────────────────────────────────────────

async function post(path: string, method = 'POST'): Promise<void> {
  const r = await fetch(`/api/media-integrations${path}`, { ...opts, method })
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? 'Action failed')
  }
}

function fmtSize(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

function SabQueueCards() {
  const qc = useQueryClient()
  const { data, isLoading } = useDownloads()
  const [deleteTarget, setDeleteTarget] = useState<SabSlot | null>(null)
  const act = useMutation({
    mutationFn: ({ path, method }: { path: string; method?: string }) => post(path, method),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-downloads'] }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Action failed'),
  })
  const sab = data?.sab ?? null

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="inline-flex items-center gap-2"><Download className="size-4" /> Download queue</CardTitle>
            <CardDescription>
              {sab
                ? sab.paused
                  ? 'SABnzbd is paused'
                  : sab.slots.length
                    ? `${sab.slots.length} downloading · ${sab.speed}B/s · ${sab.sizeLeft} left`
                    : 'Queue is empty'
                : isLoading ? 'Loading…' : 'Connect SABnzbd above to see the queue'}
            </CardDescription>
          </div>
          {sab && (
            <Button
              type="button" variant="secondary" size="sm"
              onClick={() => act.mutate({ path: sab.paused ? '/downloads/queue/resume' : '/downloads/queue/pause' })}
              disabled={act.isPending}
            >
              {sab.paused ? <><Play className="size-4" /> Resume queue</> : <><Pause className="size-4" /> Pause queue</>}
            </Button>
          )}
        </CardHeader>
        {sab && sab.slots.length > 0 && (
          <CardContent className="space-y-2">
            {sab.slots.map((s) => {
              const paused = s.status.toLowerCase() === 'paused'
              return (
                <div key={s.nzoId} className="flex items-center gap-3 rounded-card border border-border/50 bg-card/40 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{s.filename}</p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, s.percentage)}%` }} />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {s.percentage}% · {fmtSize(s.mb - s.mbLeft)} of {fmtSize(s.mb)}{s.timeLeft ? ` · ${s.timeLeft} left` : ''}{paused ? ' · paused' : ''}
                      </span>
                    </div>
                  </div>
                  <Button
                    type="button" variant="ghost" size="icon" title={paused ? 'Resume' : 'Pause'}
                    onClick={() => act.mutate({ path: `/downloads/item/${encodeURIComponent(s.nzoId)}/${paused ? 'resume' : 'pause'}` })}
                    disabled={act.isPending}
                  >
                    {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                  </Button>
                  <Button
                    type="button" variant="ghost" size="icon" title="Delete" className="text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteTarget(s)} disabled={act.isPending}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )
            })}
          </CardContent>
        )}
      </Card>

      {sab && sab.history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2"><History className="size-4" /> Recent history</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {sab.history.slice(0, 15).map((h) => (
              <div key={h.nzoId} className="flex items-center gap-3 rounded-card border border-border/50 bg-card/40 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{h.name}</p>
                  {h.failMessage && <p className="truncate text-xs text-destructive">{h.failMessage}</p>}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  h.status.toLowerCase() === 'completed' ? 'bg-success/15 text-success'
                    : h.status.toLowerCase() === 'failed' ? 'bg-destructive/15 text-destructive'
                      : 'bg-muted text-muted-foreground'
                }`}>{h.status}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{h.size}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
        title="Delete this download?"
        description={deleteTarget ? `"${deleteTarget.filename}" will be removed from the SABnzbd queue.` : ''}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (deleteTarget) act.mutate({ path: `/downloads/item/${encodeURIComponent(deleteTarget.nzoId)}`, method: 'DELETE' })
          setDeleteTarget(null)
        }}
      />
    </>
  )
}

// ── The per-product page ──────────────────────────────────────────────────────────────

export function AdminMediaServiceTab({ service }: { service: MediaService }) {
  // Reset transient state when hopping between the product pages (same component).
  const [mountKey, setMountKey] = useState(service)
  useEffect(() => setMountKey(service), [service])

  return (
    <div key={mountKey} className="space-y-6">
      <ConnectionCard service={service} />
      {(service === 'sonarr' || service === 'radarr') && (
        <>
          <ArrDefaultsCard service={service} />
          <RequestPipelineCard service={service} />
          <ArrActivityCard service={service} />
        </>
      )}
      {service === 'overseerr' && <RequestPipelineCard service="overseerr" />}
      {service === 'sabnzbd' && <SabQueueCards />}
    </div>
  )
}
