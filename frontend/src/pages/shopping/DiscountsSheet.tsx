// Per-user standing discounts ("Military 10%" at Lowe's, "RedCard 5%" at Target).
// These drive every effective price and "Best" flag in the app, and alerts compare in
// these terms when a watch has "use my price" on.

import { useEffect, useState } from 'react'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BadgePercent, Loader2, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'

export interface ShoppingDiscount {
  id: string
  retailer: string
  label: string
  percentOff: number
  maxDiscountCents: number | null
  active: boolean
}

// Only stores whose prices we can actually retrieve; applying a discount to a store we
// can't price would be theater. Home Depot/Lowe's/Apple/Costco/BJ's are bot-blocked from
// a home IP, so we don't offer discounts for them.
const PRICEABLE = new Set(['amazon', 'walmart', 'target'])

const PRESETS = [
  { retailer: 'target', label: 'RedCard 5%', percentOff: 5 },
]

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  retailerLabels: Record<string, string>
  onChanged?: () => void
}

export function DiscountsSheet({ open, onOpenChange, retailerLabels, onChanged }: Props) {
  const [discounts, setDiscounts] = useState<ShoppingDiscount[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [retailer, setRetailer] = useState('amazon')
  const [label, setLabel] = useState('')
  const [percent, setPercent] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)

  async function load() {
    const res = await fetch('/api/shopping/discounts', { credentials: 'include' })
    if (res.ok) {
      const data = await res.json() as { discounts: ShoppingDiscount[] }
      setDiscounts(data.discounts)
    }
    setLoading(false)
  }

  useEffect(() => {
    if (open) { setLoading(true); void load() }
  }, [open])

  async function create(input: { retailer: string; label: string; percentOff: number }) {
    const res = await fetch('/api/shopping/discounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    })
    if (res.ok) {
      setAdding(false)
      setLabel('')
      setPercent('')
      await load()
      onChanged?.()
    }
  }

  async function toggle(d: ShoppingDiscount) {
    await fetch(`/api/shopping/discounts/${d.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ active: !d.active }),
    })
    await load()
    onChanged?.()
  }

  async function remove(id: string) {
    await fetch(`/api/shopping/discounts/${id}`, { method: 'DELETE', credentials: 'include' })
    setDeleteId(null)
    await load()
    onChanged?.()
  }

  const unusedPresets = PRESETS.filter(p => !discounts.some(d => d.retailer === p.retailer && d.percentOff === p.percentOff))
  const retailerOptions = Object.entries(retailerLabels).filter(([id]) => PRICEABLE.has(id))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-left">
            <BadgePercent className="size-4" />
            My discounts
          </SheetTitle>
        </SheetHeader>
        <p className="mt-1 text-xs text-muted-foreground">
          Standing discounts you always get. Every price in the tracker shows what YOU would pay, and alerts can use these terms too.
        </p>

        <div className="mt-4 flex flex-col gap-4 pb-8">
          {loading ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                {discounts.length === 0 && !adding && (
                  <p className="text-xs text-muted-foreground">No discounts yet.</p>
                )}
                {discounts.map(d => (
                  <div key={d.id} className={cn('flex items-center gap-3 rounded-lg border px-3 py-2', !d.active && 'opacity-50')}>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{d.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {retailerLabels[d.retailer] ?? d.retailer} · {d.percentOff}% off
                        {d.maxDiscountCents != null && ` (max $${(d.maxDiscountCents / 100).toFixed(0)})`}
                      </div>
                    </div>
                    <button
                      onClick={() => void toggle(d)}
                      className={cn(
                        'rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                        d.active ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {d.active ? 'Active' : 'Off'}
                    </button>
                    <button onClick={() => setDeleteId(d.id)} className="rounded-md p-1 text-muted-foreground transition-colors hover:text-destructive">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              {unusedPresets.length > 0 && !adding && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Quick add</span>
                  <div className="flex flex-wrap gap-1.5">
                    {unusedPresets.map(p => (
                      <button
                        key={`${p.retailer}-${p.label}`}
                        onClick={() => void create(p)}
                        className="rounded-full border border-dashed px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                      >
                        + {retailerLabels[p.retailer] ?? p.retailer}: {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {adding ? (
                <div className="flex flex-col gap-3 rounded-lg border p-3">
                  <div className="flex flex-wrap gap-1.5">
                    {retailerOptions.map(([id, name]) => (
                      <button
                        key={id}
                        onClick={() => setRetailer(id)}
                        className={cn(
                          'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                          retailer === id
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-transparent bg-muted/50 text-muted-foreground hover:border-border hover:text-foreground',
                        )}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  <Input value={label} onChange={e => setLabel(e.target.value)} placeholder='Name (e.g. "Military 10%")' className="h-8 text-sm" />
                  <div className="flex items-center gap-2">
                    <Input value={percent} onChange={e => setPercent(e.target.value)} inputMode="decimal" placeholder="10" className="h-8 w-20 text-sm" />
                    <span className="text-sm text-muted-foreground">% off</span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={!label.trim() || !(Number(percent) > 0)}
                      onClick={() => void create({ retailer, label: label.trim(), percentOff: Number(percent) })}
                    >
                      Add discount
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="outline" className="self-start" onClick={() => setAdding(true)}>
                  <Plus className="mr-1 size-3.5" />Add discount
                </Button>
              )}
            </>
          )}
        </div>

        <ConfirmDialog
          open={deleteId != null}
          onOpenChange={open => { if (!open) setDeleteId(null) }}
          title="Remove this discount?"
          confirmLabel="Remove"
          destructive
          onConfirm={() => { if (deleteId) void remove(deleteId) }}
        />
      </SheetContent>
    </Sheet>
  )
}
