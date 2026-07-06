import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, MapPin, RefreshCw, WifiOff } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { SkeletonListRows } from '@/components/shared/SkeletonBlocks'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'

// ── Types ─────────────────────────────────────────────────────────────────────

interface EventItem {
  text: string
  url?: string
}

interface EventsResponse {
  events: EventItem[]
  location: string | null
  source?: 'patch' | 'web'
  offline: boolean
}

// ── Setup card ────────────────────────────────────────────────────────────────

function SetupCard() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-20">
      <div className="flex max-w-sm flex-col items-center gap-5 text-center">
        <div className="flex size-16 items-center justify-center rounded-card bg-muted/60">
          <MapPin className="size-8 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-title">Set your location to see local events</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Open Settings and use &ldquo;Detect my location&rdquo; or type your city to get started.
          </p>
        </div>
        <Button
          variant="outline"
          className="gap-2"
          onClick={() => { navigate('/settings') }}
        >
          Open Settings
        </Button>
      </div>
    </div>
  )
}

// ── Event row ─────────────────────────────────────────────────────────────────

function EventRow({ event }: { event: EventItem }) {
  return (
    <Card className="flex items-center gap-3 border-border/50 px-4 py-3">
      <MapPin className="size-4 shrink-0 text-brand" />
      <p className="min-w-0 flex-1 text-sm font-medium">{event.text}</p>
      {event.url && (
        <a
          href={event.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex shrink-0 items-center justify-center rounded-control p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Open event link"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="size-4" />
        </a>
      )}
    </Card>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

async function fetchEvents(bust = false): Promise<EventsResponse> {
  const url = bust ? '/api/local-events?bust=1' : '/api/local-events'
  const r = await fetch(url, { credentials: 'include' })
  if (!r.ok) throw new Error('fetch failed')
  return (await r.json()) as EventsResponse
}

export function LocalEventsPage() {
  useAppHeader({ query: '', setQuery: () => {}, searchable: false, settingsHref: '/apps/local-events/settings' })
  const [data, setData] = useState<EventsResponse | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  usePublishUIContext({
    label: 'Local Events',
    description: data?.location
      ? `User is viewing local events near ${data.location}.`
      : 'User is on the Local Events page.',
  })

  const load = useCallback(async (bust = false) => {
    setStatus('loading')
    try {
      const result = await fetchEvents(bust)
      setData(result)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const location = data?.location ?? null
  const events = data?.events ?? []
  const isOffline = data?.offline === true
  const isWebFallback = data?.source === 'web'
  const noLocation = status === 'ready' && !location && events.length === 0

  return (
    <PageShell>
      <PageContainer className="shrink-0">
        <PageHeader
          subtitle={`Events in ${location ?? 'Your Area'}`}
          actions={
            <Button
              variant="tinted"
              size="sm"
              onClick={() => { void load(true) }}
              disabled={status === 'loading'}
              aria-label="Refresh events"
            >
              {status === 'loading' ? <Spinner size="sm" className="text-brand" /> : <RefreshCw className="size-3.5" />}
              Refresh
            </Button>
          }
        />
      </PageContainer>

      <div className="flex-1 overflow-y-auto">
        <PageContainer className="pb-6">
          {/* Loading */}
          {status === 'loading' && events.length === 0 && <SkeletonListRows count={6} />}

          {/* Offline */}
          {status === 'ready' && isOffline && (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <WifiOff className="size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No internet connection. Local events are unavailable offline.</p>
            </div>
          )}

          {/* Error */}
          {status === 'error' && (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <WifiOff className="size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Could not load events right now.</p>
              <button
                onClick={() => { void load() }}
                className="flex items-center gap-1.5 text-xs text-brand hover:underline"
              >
                <RefreshCw className="size-3" /> Try again
              </button>
            </div>
          )}

          {/* No location configured */}
          {!isOffline && noLocation && <SetupCard />}

          {/* Events list */}
          {status === 'ready' && !isOffline && events.length > 0 && (
            <div className="space-y-2">
              {isWebFallback && (
                <p className="px-1 pb-1 text-xs text-muted-foreground">
                  No Patch coverage for this area, showing event discovery links.
                </p>
              )}
              {events.map((event, i) => (
                <EventRow key={i} event={event} />
              ))}
            </div>
          )}

          {/* Ready but empty with location */}
          {status === 'ready' && !isOffline && events.length === 0 && location && (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <MapPin className="size-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No events found near {location} right now.</p>
              <button
                onClick={() => { void load() }}
                className="flex items-center gap-1.5 text-xs text-brand hover:underline"
              >
                <RefreshCw className="size-3" /> Try again
              </button>
            </div>
          )}
        </PageContainer>
      </div>
    </PageShell>
  )
}
