import { useCallback, useEffect, useRef, useState } from 'react'
import { Gift, ChevronLeft, ChevronRight, WifiOff } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { ChipRow, Chip } from '@/components/shared/ChipRow'
import { cn } from '@/lib/cn'
import { usePublishUIContext } from '@/context/UIContextProvider'

interface HolidayItem {
  date: string
  localName: string
  name: string
  countryCode: string
}

interface HolidaysResponse {
  holidays: HolidayItem[]
  country: string
  year: number
  offline?: boolean
  error?: string
}

const COUNTRIES = ['US', 'GB', 'CA', 'AU', 'IE', 'DE', 'FR', 'JP'] as const
type CountryCode = (typeof COUNTRIES)[number]

const COUNTRY_LABELS: Record<CountryCode, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  IE: 'Ireland',
  DE: 'Germany',
  FR: 'France',
  JP: 'Japan',
}

function parseLocalDate(iso: string): Date {
  const parts = iso.split('-').map(Number)
  return new Date(parts[0] ?? 0, (parts[1] ?? 1) - 1, parts[2] ?? 1)
}

function formatMonDay(iso: string): string {
  const dt = parseLocalDate(iso)
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function todayLocal(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function diffDays(today: Date, holiday: Date): number {
  return Math.round((holiday.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

interface DaysPillProps {
  diff: number
}

function DaysPill({ diff }: DaysPillProps) {
  if (diff === 0) {
    return (
      <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-semibold text-emerald-400">
        Today!
      </span>
    )
  }
  if (diff > 0 && diff < 30) {
    return (
      <span className="rounded-full bg-brand/15 px-2 py-0.5 text-xs font-semibold text-brand">
        +{diff}d
      </span>
    )
  }
  if (diff > 0) {
    return (
      <span className="text-xs text-muted-foreground">
        in {diff} days
      </span>
    )
  }
  return (
    <span className="text-xs text-muted-foreground/60">(past)</span>
  )
}

interface HolidayRowProps {
  item: HolidayItem
  diff: number
  isClosest: boolean
}

function HolidayRow({ item, diff, isClosest }: HolidayRowProps) {
  const isPast = diff < 0
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl px-4 py-3 transition-colors',
        isClosest && 'bg-brand/5 ring-1 ring-brand/20',
        isPast && 'opacity-50',
      )}
    >
      <div className="w-16 shrink-0">
        <span className="text-sm text-muted-foreground">{formatMonDay(item.date)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium leading-snug">{item.localName}</p>
        {item.name !== item.localName && (
          <p className="truncate text-xs text-muted-foreground">{item.name}</p>
        )}
      </div>
      <div className="shrink-0">
        <DaysPill diff={diff} />
      </div>
    </div>
  )
}

export function HolidaysPage() {
  const currentYear = new Date().getFullYear()
  const [country, setCountry] = useState<CountryCode>('US')
  const [year, setYear] = useState<number>(currentYear)
  const [data, setData] = useState<HolidaysResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Cache: key -> response
  const cache = useRef<Map<string, HolidaysResponse>>(new Map())

  const load = useCallback(async (c: CountryCode, y: number) => {
    const key = `${c}-${y}`
    const cached = cache.current.get(key)
    if (cached) { setData(cached); return }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/holidays?country=${c}&year=${y}`, { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to load holidays')
      const json = (await res.json()) as HolidaysResponse
      cache.current.set(key, json)
      setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(country, year) }, [load, country, year])

  usePublishUIContext({
    label: 'Holidays',
    description: `Browsing public holidays for ${COUNTRY_LABELS[country]} in ${year}.`,
  })

  const today = todayLocal()

  const sorted = [...(data?.holidays ?? [])].sort((a, b) => {
    const da = parseLocalDate(a.date)
    const db = parseLocalDate(b.date)
    const diffA = diffDays(today, da)
    const diffB = diffDays(today, db)
    const upA = diffA >= 0
    const upB = diffB >= 0
    if (upA && !upB) return -1
    if (!upA && upB) return 1
    return da.getTime() - db.getTime()
  })

  const closestIdx = sorted.findIndex((h) => diffDays(today, parseLocalDate(h.date)) >= 0)

  return (
    <PageShell gradient="linear-gradient(135deg,#881337,#be123c)" GhostIcon={Gift}>
      {/* Header row */}
      <div className="flex flex-col gap-3 px-5 pt-5 pb-3 shrink-0">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-black tracking-tight">Holidays</h1>
          {/* Year selector */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setYear((y) => y - 1)}
              className="flex size-7 items-center justify-center rounded-lg bg-foreground/8 transition-colors hover:bg-foreground/12 active:scale-95"
              aria-label="Previous year"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="w-12 text-center text-sm font-semibold tabular-nums">{year}</span>
            <button
              type="button"
              onClick={() => setYear((y) => y + 1)}
              className="flex size-7 items-center justify-center rounded-lg bg-foreground/8 transition-colors hover:bg-foreground/12 active:scale-95"
              aria-label="Next year"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        </div>

        {/* Country chips */}
        <ChipRow>
          {COUNTRIES.map((c) => (
            <Chip
              key={c}
              label={c}
              active={country === c}
              onClick={() => setCountry(c)}
            />
          ))}
        </ChipRow>
      </div>

      {/* Offline notice */}
      {data?.offline && (
        <div className="mx-5 mb-3 flex items-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
          <WifiOff className="size-4 shrink-0" />
          Showing offline US holidays (fixed dates only)
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 pb-6">
        {loading && (
          <div className="flex flex-col">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="h-4 w-14 animate-pulse rounded bg-muted" />
                <div className="h-4 flex-1 animate-pulse rounded bg-muted" />
                <div className="h-4 w-12 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="mx-2 mt-4 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && sorted.length === 0 && (
          <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
            No holidays found for {COUNTRY_LABELS[country]} in {year}.
          </div>
        )}

        {!loading && !error && sorted.length > 0 && (
          <div className="flex flex-col">
            {sorted.map((item, idx) => (
              <HolidayRow
                key={`${item.date}-${item.localName}`}
                item={item}
                diff={diffDays(today, parseLocalDate(item.date))}
                isClosest={idx === closestIdx}
              />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  )
}
