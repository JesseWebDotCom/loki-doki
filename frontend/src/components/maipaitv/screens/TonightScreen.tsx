// The household newscast: a magazine layout composing the schedule, weather,
// deliveries, and a strip of recent shared-album photos. Every section hides
// itself independently when its feature is off or its request fails.

import { useQuery } from '@tanstack/react-query'
import { CalendarDays, CloudSun, Moon, PackageCheck, Sparkles } from 'lucide-react'
import { useWeatherSnapshot } from '@/hooks/useWeatherSnapshot'
import type { TvScreenProps } from './index'
import { ScreenFrame, StatusPanel, clockLabel, dateLabel, getJson, toMs, useTick } from './shared'

interface CalendarEvent {
  id: string
  summary: string | null
  startsAt: number | string
  allDay: boolean
  member: string
  colorHex: string | null
}

interface Delivery {
  id: string
  vendor: string
  title: string | null
  status: string | null
  eventDate: number | string
}

interface SharedPhoto {
  guid: string
  url: string
  caption: string | null
  album: string
  isVideo: boolean
}

function SectionCard({ icon: Icon, heading, accent, children }: {
  icon: typeof CalendarDays
  heading: string
  accent: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-sheet border border-border/50 bg-card/40 p-6">
      <p className="flex items-center gap-3 border-b border-border/60 pb-3 text-sm font-bold uppercase tracking-[0.25em] text-muted-foreground">
        <Icon className="size-5" style={{ color: accent }} />
        {heading}
      </p>
      <div className="min-h-0 flex-1 pt-3">{children}</div>
    </div>
  )
}

export function TonightScreen({ channel, title, subtitle }: TvScreenProps) {
  const now = useTick(60_000)
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const from = dayStart.getTime()
  const tomorrowStart = from + 86_400_000

  const { snapshot, status: weatherStatus } = useWeatherSnapshot()
  const events = useQuery({
    queryKey: ['maipaitv', 'calendar', from],
    queryFn: () => getJson<{ events: CalendarEvent[] }>(`/api/icloud/calendar/events?from=${from}&to=${from + 2 * 86_400_000}`),
    refetchInterval: 5 * 60_000,
    retry: false,
  })
  const deliveries = useQuery({
    queryKey: ['maipaitv', 'arrivals'],
    queryFn: () => getJson<{ deliveries: Delivery[] }>('/api/icloud/ledger/deliveries'),
    refetchInterval: 5 * 60_000,
    retry: false,
  })
  const photos = useQuery({
    queryKey: ['maipaitv', 'memories'],
    queryFn: () => getJson<{ photos: SharedPhoto[] }>('/api/icloud/shared-albums/photos'),
    refetchInterval: 10 * 60_000,
    retry: false,
  })

  const showWeather = weatherStatus === 'ready' && snapshot != null
  const eventList = events.isSuccess ? events.data.events.slice(0, 5) : []
  const showCalendar = events.isSuccess
  const deliveryList = deliveries.isSuccess ? deliveries.data.deliveries.slice(0, 4) : []
  const showDeliveries = deliveries.isSuccess && deliveryList.length > 0
  const photoList = photos.isSuccess ? photos.data.photos.filter((p) => !p.isVideo).slice(0, 3) : []
  const showPhotos = photoList.length > 0

  const settled = weatherStatus !== 'loading' && !events.isPending && !deliveries.isPending && !photos.isPending
  const nothing = settled && !showWeather && !showCalendar && !showDeliveries && !showPhotos

  if (nothing) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={Moon} headline="A quiet night at home" note="Waiting for data" />
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame
      channel={channel}
      title={title}
      subtitle={subtitle}
      right={<span className="text-lg font-semibold tabular-nums text-muted-foreground">{clockLabel(now)}</span>}
    >
      <div className="flex h-full flex-col gap-5">
        <p className="shrink-0 text-4xl font-bold tracking-tight">
          {new Date(now).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>

        <div className="grid min-h-0 flex-1 grid-cols-3 gap-5">
          <div className="col-span-2 flex min-h-0 flex-col gap-5">
            {showCalendar ? (
              <SectionCard icon={CalendarDays} heading="Coming up" accent={channel.color}>
                {eventList.length === 0 ? (
                  <p className="text-xl text-muted-foreground">Nothing on the family calendar</p>
                ) : (
                  eventList.map((ev) => {
                    const start = toMs(ev.startsAt)
                    const tomorrow = (start ?? 0) >= tomorrowStart
                    return (
                      <div key={ev.id} className="flex items-center gap-4 border-b border-border/40 py-3 last:border-b-0">
                        <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={ev.colorHex ? { backgroundColor: ev.colorHex } : undefined} />
                        <span className="w-32 shrink-0 text-base font-semibold tabular-nums text-muted-foreground">
                          {tomorrow ? 'Tomorrow ' : ''}
                          {ev.allDay || start == null ? 'All day' : clockLabel(start)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-lg font-semibold">{ev.summary ?? 'Busy'}</span>
                        <span className="shrink-0 text-base text-muted-foreground">{ev.member}</span>
                      </div>
                    )
                  })
                )}
              </SectionCard>
            ) : null}

            {showPhotos ? (
              <SectionCard icon={Sparkles} heading="From the albums" accent={channel.color}>
                <div className="grid h-full grid-cols-3 gap-4">
                  {photoList.map((p) => (
                    <div key={p.guid} className="relative min-h-24 overflow-hidden rounded-card border border-border/50">
                      <img src={p.url} alt={p.caption ?? p.album} decoding="async" className="absolute inset-0 h-full w-full object-cover" />
                      <span className="absolute bottom-2 left-2 max-w-[90%] truncate rounded-full bg-black/65 px-3 py-1 text-sm font-semibold">
                        {p.album}
                      </span>
                    </div>
                  ))}
                </div>
              </SectionCard>
            ) : null}
          </div>

          <div className="flex min-h-0 flex-col gap-5">
            {showWeather && snapshot ? (
              <SectionCard icon={CloudSun} heading="Outside" accent={channel.color}>
                <p className="text-6xl font-bold tabular-nums">
                  {snapshot.temp}
                  <span className="text-3xl font-semibold text-muted-foreground">{snapshot.unit}</span>
                </p>
                <p className="mt-1 truncate text-xl font-semibold">{snapshot.info.desc}</p>
                <p className="mt-1 text-lg text-muted-foreground">
                  Feels {snapshot.feelsLike}
                  <span className="mx-2">|</span>
                  High {snapshot.high} / Low {snapshot.low}
                </p>
              </SectionCard>
            ) : null}

            {showDeliveries ? (
              <SectionCard icon={PackageCheck} heading="Arrivals" accent={channel.color}>
                {deliveryList.map((d) => {
                  const at = toMs(d.eventDate)
                  return (
                    <div key={d.id} className="flex items-center gap-3 border-b border-border/40 py-2.5 last:border-b-0">
                      <span className="min-w-0 flex-1 truncate text-lg font-semibold">{d.title ?? d.vendor}</span>
                      <span className="shrink-0 text-base text-muted-foreground">
                        {d.status === 'delivered' ? 'Delivered' : at != null ? dateLabel(at) : d.vendor}
                      </span>
                    </div>
                  )
                })}
              </SectionCard>
            ) : null}
          </div>
        </div>
      </div>
    </ScreenFrame>
  )
}
