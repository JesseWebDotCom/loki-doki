// Days-until board: upcoming birthdays (from synced contacts) and holidays,
// merged into countdown cards sorted soonest first.

import { useQuery } from '@tanstack/react-query'
import { Cake, PartyPopper, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { TvScreenProps } from './index'
import { ScreenFrame, StatusPanel, channelPanelStyle, getJson, useTick } from './shared'

interface BirthdayItem {
  contactName: string
  member: string
  date: string
  turnsAge: number | null
}

interface HolidayItem {
  date: string
  localName: string
  name: string
  countryCode: string
}

interface CountdownItem {
  key: string
  label: string
  detail: string
  dateMs: number
  kind: 'birthday' | 'holiday'
}

function ymdToLocalMs(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
}

function daysWord(days: number): string {
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return 'days'
}

export function CountdownScreen({ channel, title, subtitle }: TvScreenProps) {
  const now = useTick(60_000)
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const from = dayStart.getTime()
  const year = dayStart.getFullYear()

  const birthdays = useQuery({
    queryKey: ['dokitv', 'birthdays', from],
    queryFn: () => getJson<{ birthdays: BirthdayItem[] }>(`/api/icloud/contacts/birthdays?from=${from}&to=${from + 365 * 86_400_000}`),
    refetchInterval: 60 * 60_000,
    retry: 1,
  })
  const holidays = useQuery({
    queryKey: ['dokitv', 'holidays', year],
    queryFn: async () => {
      const a = await getJson<{ holidays: HolidayItem[] }>(`/api/holidays?country=US&year=${year}`)
      const b = await getJson<{ holidays: HolidayItem[] }>(`/api/holidays?country=US&year=${year + 1}`).catch(() => ({ holidays: [] as HolidayItem[] }))
      return [...a.holidays, ...b.holidays]
    },
    refetchInterval: 6 * 60 * 60_000,
    retry: 1,
  })

  const loading = birthdays.isPending || holidays.isPending
  const bothFailed = birthdays.isError && holidays.isError

  const items: CountdownItem[] = []
  for (const b of birthdays.data?.birthdays ?? []) {
    const ms = ymdToLocalMs(b.date)
    if (ms == null) continue
    items.push({
      key: `b-${b.contactName}-${b.date}`,
      label: b.contactName,
      detail: b.turnsAge != null ? `Turns ${b.turnsAge}` : `Birthday, via ${b.member}`,
      dateMs: ms,
      kind: 'birthday',
    })
  }
  for (const h of holidays.data ?? []) {
    const ms = ymdToLocalMs(h.date)
    if (ms == null) continue
    items.push({ key: `h-${h.name}-${h.date}`, label: h.localName, detail: 'Holiday', dateMs: ms, kind: 'holiday' })
  }
  const upcoming = items
    .map((it) => ({ ...it, days: Math.round((it.dateMs - from) / 86_400_000) }))
    .filter((it) => it.days >= 0)
    .sort((a, b) => a.days - b.days || a.label.localeCompare(b.label))
    .slice(0, 12)

  let panel: { headline: string; note: string } | null = null
  if (loading) panel = { headline: 'Counting the days', note: 'Waiting for data' }
  else if (bothFailed) panel = { headline: 'The countdown board is dark', note: 'We could not load upcoming dates' }
  else if (upcoming.length === 0) panel = { headline: 'No upcoming dates', note: 'Birthdays and holidays will appear here as they approach' }

  if (panel) {
    return (
      <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
        <StatusPanel channel={channel} icon={PartyPopper} headline={panel.headline} note={panel.note} />
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame channel={channel} title={title} subtitle={subtitle}>
      <div className="grid h-full grid-cols-2 grid-rows-3 gap-4 xl:grid-cols-4">
        {upcoming.map((it, i) => {
          const Icon: LucideIcon = it.kind === 'birthday' ? Cake : PartyPopper
          const featured = i === 0
          return (
            <div
              key={it.key}
              className={cn(
                'flex flex-col justify-between overflow-hidden rounded-card border border-border/50 p-5',
                !featured && 'bg-card/50',
              )}
              style={featured ? channelPanelStyle(channel) : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <Icon className="size-6" style={{ color: featured ? undefined : channel.color }} />
                <span className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
                  {new Date(it.dateMs).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                </span>
              </div>
              <div>
                <p className="text-5xl font-bold tabular-nums leading-none">
                  {it.days <= 1 ? daysWord(it.days) : it.days}
                </p>
                {it.days > 1 ? <p className="mt-1 text-base text-muted-foreground">days away</p> : null}
              </div>
              <div className="min-w-0">
                <p className="truncate text-xl font-semibold">{it.label}</p>
                <p className="truncate text-base text-muted-foreground">{it.detail}</p>
              </div>
            </div>
          )
        })}
      </div>
    </ScreenFrame>
  )
}
