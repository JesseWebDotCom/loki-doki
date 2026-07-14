// Frontend for the optional LAN media integrations (Sonarr/Radarr calendars + Overseerr
// requests): the admin config card, the "Coming to your library" calendar section, and the
// per-title Request button. All render nothing (or a prompt) when unconfigured.

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, CheckCircle2, Download, Film, Send, Tv } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ActionButton } from '@/components/media/ActionBar'

const opts: RequestInit = { credentials: 'include' }

// ── Admin config card ────────────────────────────────────────────────────────────────

interface IntegrationsConfig {
  sonarr_url: string
  radarr_url: string
  overseerr_url: string
  sonarr_key_set: boolean
  radarr_key_set: boolean
  overseerr_key_set: boolean
}

const SERVICES = [
  { urlKey: 'sonarr_url', keyKey: 'sonarr_key', setKey: 'sonarr_key_set', label: 'Sonarr', hint: 'shows calendar' },
  { urlKey: 'radarr_url', keyKey: 'radarr_key', setKey: 'radarr_key_set', label: 'Radarr', hint: 'movie releases' },
  { urlKey: 'overseerr_url', keyKey: 'overseerr_key', setKey: 'overseerr_key_set', label: 'Overseerr', hint: 'requests' },
] as const

export function MediaIntegrationsAdminCard() {
  const { data, refetch } = useQuery({
    queryKey: ['media-integrations-config'],
    queryFn: async () => {
      const r = await fetch('/api/media-integrations/config', opts)
      if (!r.ok) throw new Error('load failed')
      return (await r.json()) as IntegrationsConfig
    },
    staleTime: 60 * 1000,
  })
  const [draft, setDraft] = useState<Record<string, string>>({})
  useEffect(() => {
    if (data) setDraft((d) => ({ sonarr_url: data.sonarr_url, radarr_url: data.radarr_url, overseerr_url: data.overseerr_url, ...d }))
  }, [data])

  const save = async () => {
    const body: Record<string, string> = {}
    for (const [k, v] of Object.entries(draft)) body[k] = v
    const r = await fetch('/api/media-integrations/config', {
      ...opts, method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (r.ok) {
      toast.success('Integrations saved')
      setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !k.endsWith('_key'))))
      void refetch()
    } else toast.error('Could not save integrations')
  }

  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Connect your Sonarr, Radarr, and Overseerr servers to see what&rsquo;s coming to your library and request titles from any detail page. URL + API key per service (Settings → General → API Key in each app).
      </p>
      {SERVICES.map((svc) => (
        <div key={svc.label} className="flex flex-wrap items-center gap-2">
          <span className="w-20 text-sm font-medium">{svc.label}</span>
          <Input
            value={draft[svc.urlKey] ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, [svc.urlKey]: e.target.value }))}
            placeholder={`http://host:port (${svc.hint})`}
            className="w-64"
          />
          <Input
            type="password"
            value={draft[svc.keyKey] ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, [svc.keyKey]: e.target.value }))}
            placeholder={data?.[svc.setKey] ? 'API key saved' : 'API key'}
            className="w-48"
          />
          {data?.[svc.setKey] && <CheckCircle2 className="size-4 text-success" />}
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={() => void save()}>Save integrations</Button>
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

// ── Request button (Overseerr) ───────────────────────────────────────────────────────

interface RequestStatus {
  configured: boolean
  status: 'none' | 'pending' | 'processing' | 'partial' | 'available'
  requestable: boolean
  tmdbId: number | null
}

const STATUS_LABEL: Record<RequestStatus['status'], string | null> = {
  none: null, pending: 'Requested', processing: 'Downloading', partial: 'Partly available', available: 'Available',
}

export function RequestButton({ title, year, type }: { title: string; year: number | null; type: 'movie' | 'show' }) {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['request-status', type, title, year],
    queryFn: async () => {
      const r = await fetch(`/api/media-integrations/request-status?title=${encodeURIComponent(title)}&type=${type}${year ? `&year=${year}` : ''}`, opts)
      if (!r.ok) return null
      return (await r.json()) as RequestStatus
    },
    staleTime: 5 * 60 * 1000,
  })
  const request = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/media-integrations/request', {
        ...opts, method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmdbId: data?.tmdbId, type }),
      })
      if (!r.ok) throw new Error('request failed')
    },
    onSuccess: () => {
      toast.success(`Requested "${title}"`)
      void qc.invalidateQueries({ queryKey: ['request-status', type, title, year] })
    },
    onError: () => toast.error('Request failed'),
  })

  if (!data?.configured) return null
  const label = STATUS_LABEL[data.status]
  if (label) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-3 py-1.5 text-xs font-semibold text-success">
        <CheckCircle2 className="size-3.5" /> {label}
      </span>
    )
  }
  if (!data.requestable || !data.tmdbId) return null
  return <ActionButton icon={Send} label={request.isPending ? 'Requesting…' : 'Request'} onClick={() => request.mutate()} disabled={request.isPending} />
}
