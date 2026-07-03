import { useEffect, useState } from 'react'
import { WifiOff } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { SkeletonListRows } from '@/components/shared/SkeletonBlocks'
import { Card } from '@/components/ui/card'
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
    <div className="space-y-2">
      {items.map((item, i) => (
        <Card key={i} className="px-4 py-3">
          <p className="text-sm leading-snug">{item.title}</p>
        </Card>
      ))}
    </div>
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
    <PageShell>
      <PageContainer width="narrow" className="pb-10">
        <PageHeader subtitle={dateLabel} />

        {status === 'loading' && <SkeletonListRows count={8} />}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-3 py-20 text-center">
            <WifiOff className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Couldn't load history right now.</p>
          </div>
        )}

        {status === 'ready' && data && (
          <div className="space-y-8">
            <section>
              <SectionHeader title="Events" className="mb-4" />
              <EntryList items={data.events} emptyLabel="No events found for this date." />
            </section>

            <section>
              <SectionHeader title="Notable Births" className="mb-4" />
              <EntryList items={data.births} emptyLabel="No births found for this date." />
            </section>

            <section>
              <SectionHeader title="Notable Deaths" className="mb-4" />
              <EntryList items={data.deaths} emptyLabel="No deaths found for this date." />
            </section>
          </div>
        )}
      </PageContainer>
    </PageShell>
  )
}
