import { useEffect, useState } from 'react'
import { Package, ReceiptText, Truck, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'

// Household Ledger: what the mail extractor found; package deliveries (household-
// visible: they arrive at the house) and purchase/subscription receipts (owner +
// admins; finances stay a parent surface). All extraction is deterministic
// sender/subject regex over the local mail index; no LLM and no bodies stored.

interface Delivery {
  id: string
  vendor: string
  title: string | null
  trackingNumber: string | null
  status: string | null
  eventDate: string
  member: string
}

interface Receipt {
  id: string
  vendor: string
  title: string | null
  amount: string | null
  eventDate: string
  member: string
}

type TabKey = 'deliveries' | 'spending'

const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: 'deliveries', label: 'Deliveries', icon: Truck },
  { key: 'spending', label: 'Spending', icon: ReceiptText },
]

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  delivered: { label: 'Delivered', cls: 'bg-success/10 text-success' },
  out_for_delivery: { label: 'Out for delivery', cls: 'bg-warning/10 text-warning' },
  shipped: { label: 'On the way', cls: 'bg-info/10 text-info' },
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function DeliveryRow({ d }: { d: Delivery }) {
  const status = d.status ? STATUS_LABEL[d.status] : null
  return (
    <div className="flex items-center gap-3 border-b border-border/25 py-2.5 last:border-b-0">
      <Package className="size-4 shrink-0 text-muted-foreground/70" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground/90">{d.title ?? `${d.vendor} package`}</p>
        <p className="text-xs text-muted-foreground">
          {d.vendor} · {d.member}{d.trackingNumber ? ` · ${d.trackingNumber}` : ''}
        </p>
      </div>
      {status && <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs', status.cls)}>{status.label}</span>}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{dayLabel(d.eventDate)}</span>
    </div>
  )
}

function ReceiptRow({ r }: { r: Receipt }) {
  return (
    <div className="flex items-center gap-3 border-b border-border/25 py-2.5 last:border-b-0">
      <ReceiptText className="size-4 shrink-0 text-muted-foreground/70" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground/90">{r.title ?? r.vendor}</p>
        <p className="text-xs text-muted-foreground">{r.vendor} · {r.member}</p>
      </div>
      {r.amount && <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground/85">{r.amount}</span>}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{dayLabel(r.eventDate)}</span>
    </div>
  )
}

export function LedgerPage() {
  useAppHeader({ query: '', setQuery: () => {}, searchable: false })
  const { user } = useAuth()
  const [tab, setTab] = useState<TabKey>('deliveries')
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null)
  const [receipts, setReceipts] = useState<Receipt[] | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'disabled' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/icloud/ledger/deliveries', { credentials: 'include' }),
      fetch('/api/icloud/ledger/receipts', { credentials: 'include' }),
    ]).then(async ([dRes, rRes]) => {
      if (cancelled) return
      if (dRes.status === 403) { setState('disabled'); return }
      const d = await dRes.json() as { deliveries: Delivery[] }
      const r = await rRes.json().catch(() => ({ receipts: [] })) as { receipts: Receipt[] }
      setDeliveries(d.deliveries)
      setReceipts(r.receipts)
      setState('ready')
    }).catch(() => { if (!cancelled) setState('error') })
    return () => { cancelled = true }
  }, [])

  const counts: Record<TabKey, number> = {
    deliveries: deliveries?.length ?? 0,
    spending: receipts?.length ?? 0,
  }

  return (
    <PageShell>
      <PageContainer width="narrow" className="py-2 pb-8">
        <PageHeader subtitle="Deliveries and purchases, spotted in the family's mail." />

        {state === 'disabled' ? (
          <div className="rounded-card border border-border/40 p-6 text-sm text-muted-foreground">
            <p className="mb-2 font-medium text-foreground/85">The Ledger needs iCloud Mail.</p>
            <p>
              {user?.role === 'admin'
                ? <>Turn on <strong>iCloud Mail</strong> in <Link to="/admin/features" className="underline underline-offset-2">Admin → Features</Link> and connect Apple Accounts; deliveries and receipts appear as mail arrives.</>
                : 'Ask a household admin to turn on iCloud Mail in Admin.'}
            </p>
          </div>
        ) : state === 'error' ? (
          <p className="py-8 text-sm text-muted-foreground">Could not load the ledger. Try again in a moment.</p>
        ) : state === 'loading' ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : (
          <>
            <div className="mb-5 inline-flex w-full rounded-full bg-foreground/8 p-1 sm:w-auto">
              {TABS.map(({ key, label, icon: Icon }) => {
                const active = tab === key
                return (
                  // design-ok(hand-styled-button): segmented tab picker, mirrors TimePage's tab pills
                  <button key={key} onClick={() => setTab(key)}
                    className={cn('flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 text-sm font-semibold transition-colors sm:flex-none',
                      active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                    <Icon className="size-4" />
                    <span>{label}</span>
                    {counts[key] > 0 && (
                      <span className={cn('inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums',
                        active ? 'bg-brand text-brand-foreground' : 'bg-foreground/10 text-muted-foreground')}>
                        {counts[key]}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            {tab === 'deliveries' && (
              deliveries && deliveries.length > 0
                ? <div>{deliveries.map((d) => <DeliveryRow key={d.id} d={d} />)}</div>
                : <p className="py-6 text-sm text-muted-foreground">
                    No deliveries spotted in the last 30 days. Carrier and Amazon notices show up here automatically.
                  </p>
            )}
            {tab === 'spending' && (
              receipts && receipts.length > 0
                ? <div>{receipts.map((r) => <ReceiptRow key={r.id} r={r} />)}</div>
                : <p className="py-6 text-sm text-muted-foreground">
                    No receipts spotted yet. Apple receipts, order confirmations, and payment emails land here.
                    Spending is visible to each account's owner and to admins.
                  </p>
            )}
          </>
        )}
      </PageContainer>
    </PageShell>
  )
}
