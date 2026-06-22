import { useEffect, useState } from 'react'
import { CalendarDays, Loader2, WifiOff } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { usePublishUIContext } from '@/context/UIContextProvider'

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

interface OtdItem { title: string }

interface OtdData {
  events: OtdItem[]
  births: OtdItem[]
  deaths: OtdItem[]
  month: number
  day: number
  error?: string
}

async function fetchOtd(): Promise<OtdData> {
  const r = await fetch('/api/on-this-day', { credentials: 'include' })
  if (!r.ok) throw new Error('fetch failed')
  return (await r.json()) as OtdData
}

function EntryList({ items, emptyLabel }: { items: OtdItem[]; emptyLabel: string }) {
  if (!items.length) {
    return <p className="text-sm text-muted-foreground py-4">{emptyLabel}</p>
  }
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="rounded-xl border border-border/50 bg-card px-4 py-3">
          <p className="text-sm leading-snug">{item.title}</p>
        </li>
      ))}
    </ul>
  )
}

export function OnThisDayPage() {
  const [data, setData] = useState<OtdData | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  const now = new Date()
  const monthName = MONTHS[now.getMonth()] ?? ''
  const dateLabel = `${monthName} ${now.getDate()}`

  usePublishUIContext({ label: 'On This Day', description: `User is viewing history for ${dateLabel}.` })

  useEffect(() => {
    fetchOtd()
      .then((d) => { setData(d); setStatus('ready') })
      .catch(() => setStatus('error'))
  }, [])

  return (
    <PageShell gradient="linear-gradient(135deg,#4a1a1a,#7c3a1a)" GhostIcon={CalendarDays}>
      <PageHeader
        variant="compact"
        title="On This Day"
        subtitle={dateLabel}
        gradient="linear-gradient(135deg,#4a1a1a,#7c3a1a)"
        icon={<CalendarDays className="size-7 text-white" />}
      />
      <div className="px-5 pb-10">

        {status === 'loading' && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <WifiOff className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Couldn't load history right now.</p>
          </div>
        )}

        {status === 'ready' && data && (
          <div className="space-y-8">
            <section>
              <SectionHeader title="Events" />
              <EntryList items={data.events} emptyLabel="No events found for this date." />
            </section>

            <section>
              <SectionHeader title="Notable Births" />
              <EntryList items={data.births} emptyLabel="No births found for this date." />
            </section>

            <section>
              <SectionHeader title="Notable Deaths" />
              <EntryList items={data.deaths} emptyLabel="No deaths found for this date." />
            </section>
          </div>
        )}
      </div>
    </PageShell>
  )
}
