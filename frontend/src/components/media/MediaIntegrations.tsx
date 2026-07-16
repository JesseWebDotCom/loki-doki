// Frontend for the optional LAN media integrations (Sonarr/Radarr calendars + Overseerr
// requests): the admin config card, the "Coming to your library" calendar section, and the
// per-title Request button. All render nothing (or a prompt) when unconfigured.

import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, CheckCircle2, Download, Film, Send, Tv, X } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { ActionButton } from '@/components/media/ActionBar'
import {
  ConnectionCard, ArrDefaultsCard, RequestPipelineCard, SERVICE_META,
} from '@/components/media/MediaServiceCards'

const opts: RequestInit = { credentials: 'include' }

// ── Admin config card ────────────────────────────────────────────────────────────────

export interface IntegrationsConfig {
  sonarr_url: string
  radarr_url: string
  overseerr_url: string
  sabnzbd_url: string
  sonarr_key_set: boolean
  radarr_key_set: boolean
  overseerr_key_set: boolean
  sabnzbd_key_set: boolean
  request_pipeline: 'overseerr' | 'direct'
  radarr_quality_profile_id: string
  radarr_root_folder: string
  sonarr_quality_profile_id: string
  sonarr_root_folder: string
}

export interface ArrTestInfo {
  ok: boolean
  version?: string
  qualityProfiles?: Array<{ id: number; name: string }>
  rootFolders?: Array<{ id: number; path: string }>
}
export interface TestResult {
  sonarr: ArrTestInfo
  radarr: ArrTestInfo
  overseerr: { ok: boolean; version?: string }
  sabnzbd: { ok: boolean; version?: string }
}

/** Shared admin config query, reused by the per-product admin pages. */
export function useIntegrationsConfig() {
  return useQuery({
    queryKey: ['media-integrations-config'],
    queryFn: async () => {
      const r = await fetch('/api/media-integrations/config', opts)
      if (!r.ok) throw new Error('load failed')
      return (await r.json()) as IntegrationsConfig
    },
    staleTime: 60 * 1000,
  })
}

export async function saveIntegrationsConfig(patch: Record<string, string>): Promise<boolean> {
  const r = await fetch('/api/media-integrations/config', {
    ...opts, method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })
  return r.ok
}

export async function testIntegrations(): Promise<TestResult | null> {
  const r = await fetch('/api/media-integrations/test', opts)
  if (!r.ok) return null
  return (await r.json()) as TestResult
}

export type MediaServiceId = 'sonarr' | 'radarr' | 'overseerr' | 'sabnzbd'

const ALL_SERVICES: MediaServiceId[] = ['sonarr', 'radarr', 'overseerr', 'sabnzbd']

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Admin config for the LAN media services. `services` filters which ones this mount
 *  shows (Shows settings passes sonarr+overseerr, Movies radarr+overseerr, the admin
 *  hub all four); every mount reads and writes the same shared config. A thin
 *  composition of the per-service cards in MediaServiceCards (the same cards the
 *  Admin → Integrations product pages use), so connection semantics, secret
 *  handling, and the request pipeline stay defined in exactly one place. */
export function MediaIntegrationsAdminCard({ services = ALL_SERVICES }: { services?: MediaServiceId[] }) {
  return (
    <section className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Connect {listNames(services.map((s) => SERVICE_META[s].label))} to see what&rsquo;s coming to your library, request titles from any detail page, and track downloads. URL + API key per service (Settings → General → API Key in each app).
      </p>
      {services.map((svc) => (
        <Fragment key={svc}>
          <ConnectionCard service={svc} />
          {(svc === 'sonarr' || svc === 'radarr') && <ArrDefaultsCard service={svc} />}
        </Fragment>
      ))}
      {services.includes('overseerr') && (
        <RequestPipelineCard service="overseerr" sharedNote={services.length < ALL_SERVICES.length} />
      )}
    </section>
  )
}

// ── "Coming to your library" (Sonarr/Radarr merged calendar) ─────────────────────────

interface LibraryCalendarEntry {
  kind: 'episode' | 'movie'
  title: string
  detail: string | null
  date: string
  hasFile: boolean
}

export function LibraryCalendarSection() {
  const { data } = useQuery({
    queryKey: ['arr-calendar'],
    queryFn: async () => {
      const r = await fetch('/api/media-integrations/calendar', opts)
      if (!r.ok) return { entries: [] as LibraryCalendarEntry[] }
      return (await r.json()) as { entries: LibraryCalendarEntry[] }
    },
    staleTime: 15 * 60 * 1000,
  })
  const entries = data?.entries ?? []
  if (!entries.length) return null
  return (
    <section className="mt-10">
      <h3 className="mb-3 inline-flex items-center gap-2 text-base font-semibold">
        <Download className="size-4 text-brand" /> Coming to Your Library
      </h3>
      <div className="space-y-2">
        {entries.slice(0, 20).map((e, i) => (
          <div key={`${e.title}-${e.date}-${i}`} className="flex items-center gap-3 rounded-card border border-border/50 bg-card/40 p-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand/15 text-brand">
              {e.kind === 'episode' ? <Tv className="size-4" /> : <Film className="size-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{e.title}</p>
              {e.detail && <p className="truncate text-xs text-muted-foreground">{e.detail}</p>}
            </div>
            <p className="inline-flex shrink-0 items-center gap-1.5 text-sm"><CalendarDays className="size-4 text-brand" />{e.date}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Request button (pipeline-aware: Overseerr or direct Radarr/Sonarr) ──────────────

interface RequestStatus {
  configured: boolean
  pipeline: 'overseerr' | 'direct'
  canRequest: boolean
  reason?: 'unconfigured' | 'grant' | 'link_plex'
  status: 'none' | 'pending' | 'processing' | 'partial' | 'available' | 'requested' | 'downloading' | 'ready' | 'failed'
  progress: number | null
  requestable: boolean
  tmdbId: number | null
  deepLink: string | null
}

const STATUS_LABEL: Record<RequestStatus['status'], string | null> = {
  none: null, pending: 'Requested', processing: 'Downloading', partial: 'Partly available', available: 'Available',
  requested: 'Requested', downloading: 'Downloading', ready: 'Ready to watch', failed: 'Request failed',
}

const ACTIVE_STATUSES = new Set(['pending', 'processing', 'requested', 'downloading'])

export interface RequestButtonProps {
  title: string
  year: number | null
  type: 'movie' | 'show'
  refId?: string
  imdb?: string | null
  tvdb?: number | null
  posterUrl?: string | null
}

export function RequestButton({ title, year, type, refId, imdb, tvdb, posterUrl }: RequestButtonProps) {
  const qc = useQueryClient()
  const ref = refId ?? title
  const { data } = useQuery({
    queryKey: ['request-status', type, ref, year],
    queryFn: async () => {
      const qs = new URLSearchParams({ title, type, refId: ref })
      if (year) qs.set('year', String(year))
      if (imdb) qs.set('imdb', imdb)
      if (tvdb) qs.set('tvdb', String(tvdb))
      const r = await fetch(`/api/media-integrations/request-status?${qs}`, opts)
      if (!r.ok) return null
      return (await r.json()) as RequestStatus
    },
    staleTime: 60 * 1000,
    refetchInterval: (query) => (query.state.data && ACTIVE_STATUSES.has(query.state.data.status) ? 30_000 : false),
  })
  const request = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/media-integrations/request', {
        ...opts, method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type, title, year, refId: ref, imdb: imdb ?? undefined, tvdb: tvdb ?? undefined,
          tmdbId: data?.tmdbId ?? undefined, posterUrl: posterUrl ?? undefined,
        }),
      })
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? 'Request failed')
      }
    },
    onSuccess: () => {
      toast.success(`Requested "${title}"`)
      void qc.invalidateQueries({ queryKey: ['request-status', type, ref, year] })
      void qc.invalidateQueries({ queryKey: ['my-media-requests'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Request failed'),
  })

  if (!data?.configured) return null

  const label = STATUS_LABEL[data.status]
  if (data.status === 'ready' || data.status === 'available') {
    const chip = (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-3 py-1.5 text-xs font-semibold text-success">
        <CheckCircle2 className="size-3.5" /> {label}
      </span>
    )
    return data.deepLink ? <a href={data.deepLink} target="_blank" rel="noreferrer">{chip}</a> : chip
  }
  if (label && data.status !== 'failed') {
    const pct = data.status === 'downloading' && data.progress != null ? ` ${Math.round(data.progress)}%` : ''
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-brand/15 px-3 py-1.5 text-xs font-semibold text-brand">
        <Download className="size-3.5" /> {label}{pct}
      </span>
    )
  }

  if (!data.canRequest) {
    if (data.reason === 'link_plex') {
      return (
        <Link to="/movies/settings" className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
          <Send className="size-3.5" /> Link Plex to request
        </Link>
      )
    }
    return null
  }
  if (!data.requestable) return null
  const buttonLabel = data.status === 'failed' ? 'Request again' : 'Request'
  return <ActionButton icon={Send} label={request.isPending ? 'Requesting…' : buttonLabel} onClick={() => request.mutate()} disabled={request.isPending} />
}

// ── My requests (per-user request tracking list) ─────────────────────────────────────

interface MediaRequestRow {
  id: string
  mediaType: 'show' | 'movie'
  refId: string
  title: string
  year: number | null
  posterUrl: string | null
  status: 'requested' | 'downloading' | 'ready' | 'failed'
  progress: number | null
  plexDeepLink: string | null
  origin: 'app' | 'companion' | 'external'
}

const REQUEST_STATUS_META: Record<MediaRequestRow['status'], { label: string; cls: string }> = {
  requested: { label: 'Requested', cls: 'bg-brand/15 text-brand' },
  downloading: { label: 'Downloading', cls: 'bg-brand/15 text-brand' },
  ready: { label: 'Ready', cls: 'bg-success/15 text-success' },
  failed: { label: 'Failed', cls: 'bg-destructive/15 text-destructive' },
}

export function MyRequestsSection({ mediaType }: { mediaType?: 'show' | 'movie' }) {
  const qc = useQueryClient()
  const [removeTarget, setRemoveTarget] = useState<MediaRequestRow | null>(null)
  const { data } = useQuery({
    queryKey: ['my-media-requests'],
    queryFn: async () => {
      const r = await fetch('/api/media-integrations/requests/mine', opts)
      if (!r.ok) return { requests: [] as MediaRequestRow[] }
      return (await r.json()) as { requests: MediaRequestRow[] }
    },
    staleTime: 30 * 1000,
    refetchInterval: (query) =>
      (query.state.data?.requests ?? []).some((r) => r.status === 'requested' || r.status === 'downloading') ? 30_000 : false,
  })
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/media-integrations/requests/${id}`, { ...opts, method: 'DELETE' })
      if (!r.ok) throw new Error('remove failed')
    },
    onSuccess: () => {
      toast.success('Request removed')
      void qc.invalidateQueries({ queryKey: ['my-media-requests'] })
    },
    onError: () => toast.error('Could not remove the request'),
  })

  const requests = (data?.requests ?? []).filter((r) => !mediaType || r.mediaType === mediaType)
  if (!requests.length) return null
  return (
    <section className="mt-10">
      <h3 className="mb-3 inline-flex items-center gap-2 text-base font-semibold">
        <Send className="size-4 text-brand" /> My Requests
      </h3>
      <div className="space-y-2">
        {requests.slice(0, 12).map((r) => {
          const meta = REQUEST_STATUS_META[r.status]
          return (
            <div key={r.id} className="flex items-center gap-3 rounded-card border border-border/50 bg-card/40 p-3">
              {r.posterUrl ? (
                <img src={r.posterUrl} alt="" className="h-14 w-10 shrink-0 rounded-control object-cover" loading="lazy" />
              ) : (
                <div className="flex h-14 w-10 shrink-0 items-center justify-center rounded-control bg-brand/15 text-brand">
                  {r.mediaType === 'show' ? <Tv className="size-4" /> : <Film className="size-4" />}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {r.title}{r.year ? <span className="text-muted-foreground font-normal"> ({r.year})</span> : null}
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>
                    {meta.label}{r.status === 'downloading' && r.progress != null ? ` ${Math.round(r.progress)}%` : ''}
                  </span>
                  {r.status === 'downloading' && r.progress != null && (
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, r.progress)}%` }} />
                    </div>
                  )}
                </div>
              </div>
              {r.status === 'ready' && r.plexDeepLink && (
                <a href={r.plexDeepLink} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-semibold text-success hover:underline">
                  Watch on Plex
                </a>
              )}
              <Button
                type="button" variant="ghost" size="icon" className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => setRemoveTarget(r)} title="Remove request"
              >
                <X className="size-4" />
              </Button>
            </div>
          )
        })}
      </div>
      <ConfirmDialog
        open={removeTarget != null}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}
        title="Remove this request?"
        description={removeTarget ? `"${removeTarget.title}" will disappear from your requests. The download itself is not cancelled.` : ''}
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (removeTarget) remove.mutate(removeTarget.id)
          setRemoveTarget(null)
        }}
      />
    </section>
  )
}

// ── Direct-mode per-user request grants (admin, shown inside the admin card) ─────────

interface GrantUser { id: string; name: string; role: 'admin' | 'user'; allowed: boolean }

export function RequestGrantsList() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['media-request-grants'],
    queryFn: async () => {
      const r = await fetch('/api/media-integrations/grants', opts)
      if (!r.ok) throw new Error('load failed')
      return (await r.json()) as { users: GrantUser[] }
    },
    staleTime: 60 * 1000,
  })
  const setGrant = useMutation({
    mutationFn: async ({ userId, allowed }: { userId: string; allowed: boolean }) => {
      const r = await fetch(`/api/media-integrations/grants/${userId}`, {
        ...opts, method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowed }),
      })
      if (!r.ok) throw new Error('save failed')
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['media-request-grants'] }),
    onError: () => toast.error('Could not update the permission'),
  })
  if (!data?.users.length) return null
  return (
    <div className="space-y-2 pt-1">
      <p className="text-sm font-medium">Who can request downloads</p>
      {data.users.map((u) => (
        <label key={u.id} className="flex items-center gap-2 text-sm">
          <Switch
            checked={u.allowed}
            disabled={u.role === 'admin' || setGrant.isPending}
            onCheckedChange={(checked) => setGrant.mutate({ userId: u.id, allowed: checked })}
          />
          <span>{u.name}</span>
          {u.role === 'admin' && <span className="text-xs text-muted-foreground">admin, always allowed</span>}
        </label>
      ))}
    </div>
  )
}
