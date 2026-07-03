// Snap or upload a photo of a barcode, product, box, or label → we identify it and show
// candidate products; the user picks one to track. Nothing is tracked without a pick.

import { useRef, useState } from 'react'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Camera, Loader2, Plus, ScanBarcode } from 'lucide-react'
import { proxyImg } from '@/lib/img'
import { RETAILER_COLORS } from './PriceChart'

interface Candidate {
  retailer: string
  externalId: string
  url: string
  title: string
  imageUrl: string | null
  priceCents: number | null
}

interface IdentifyResponse {
  barcode: string | null
  guess: string | null
  brand: string | null
  candidates: Candidate[]
  note?: string
  labels: Record<string, string>
}

function fmt(cents: number | null): string {
  return cents == null ? '—' : `$${(cents / 100).toFixed(2)}`
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onTracked: (retailer: string, externalId: string, preview: { title: string; imageUrl: string | null; priceCents: number | null; url: string }) => void
}

export function PhotoLookupSheet({ open, onOpenChange, onTracked }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [identifying, setIdentifying] = useState(false)
  const [result, setResult] = useState<IdentifyResponse | null>(null)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [trackingKey, setTrackingKey] = useState<string | null>(null)

  function reset() {
    setPreview(null); setResult(null); setQuery(''); setIdentifying(false)
  }

  async function onFile(file: File) {
    reset()
    setPreview(URL.createObjectURL(file))
    setIdentifying(true)
    const form = new FormData()
    form.append('photo', file)
    const res = await fetch('/api/shopping/identify', { method: 'POST', credentials: 'include', body: form })
    setIdentifying(false)
    if (res.ok) {
      const data = await res.json() as IdentifyResponse
      setResult(data)
      setQuery(data.guess ?? '')
    } else {
      const data = await res.json().catch(() => ({})) as { message?: string; error?: string }
      setResult({ barcode: null, guess: null, brand: null, candidates: [], note: data.message ?? data.error ?? 'Identification failed', labels: {} })
    }
  }

  async function research() {
    if (query.trim().length < 2) return
    setSearching(true)
    const res = await fetch(`/api/shopping/search?q=${encodeURIComponent(query)}`, { credentials: 'include' })
    if (res.ok) {
      const data = await res.json() as { results: Record<string, Candidate[]>; labels: Record<string, string> }
      const flat = Object.values(data.results).flat()
      setResult(prev => ({ barcode: prev?.barcode ?? null, guess: query, brand: prev?.brand ?? null, candidates: flat, labels: data.labels }))
    }
    setSearching(false)
  }

  async function track(c: Candidate) {
    const key = `${c.retailer}:${c.externalId}`
    setTrackingKey(key)
    const res = await fetch('/api/shopping/products', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ url: c.url }),
    })
    setTrackingKey(null)
    if (res.ok) {
      onTracked(c.retailer, c.externalId, { title: c.title, imageUrl: c.imageUrl, priceCents: c.priceCents, url: c.url })
      onOpenChange(false)
      reset()
    }
  }

  return (
    <Sheet open={open} onOpenChange={o => { onOpenChange(o); if (!o) reset() }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-left">
            <ScanBarcode className="size-4" />
            Look up by photo
          </SheetTitle>
        </SheetHeader>
        <p className="mt-1 text-xs text-muted-foreground">
          Snap a barcode, product, box, or label — we'll find it so you can track its price.
        </p>

        <div className="mt-4 flex flex-col gap-4 pb-8">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f) }}
          />

          {!preview ? (
            <button
              onClick={() => fileRef.current?.click()}
              className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed py-10 text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            >
              <Camera className="size-8" />
              <span className="text-sm font-medium">Take or choose a photo</span>
            </button>
          ) : (
            <div className="flex flex-col gap-3">
              <img src={preview} alt="" className="max-h-48 w-full rounded-lg object-contain bg-muted" />
              <Button size="sm" variant="ghost" className="self-start" onClick={() => fileRef.current?.click()}>
                Use a different photo
              </Button>
            </div>
          )}

          {identifying && (
            <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Reading the photo…
            </div>
          )}

          {result && (
            <>
              {result.barcode && (
                <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs">
                  <ScanBarcode className="size-3.5 text-muted-foreground" />
                  <span className="font-mono">{result.barcode}</span>
                </div>
              )}
              {result.note && <p className="text-xs text-muted-foreground">{result.note}</p>}

              {/* Editable search phrase — the guess is a starting point, not a commitment. */}
              <div className="flex gap-2">
                <Input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void research() }} placeholder="Refine the search…" className="h-8 text-sm" />
                <Button size="sm" variant="outline" onClick={research} disabled={searching || query.trim().length < 2}>
                  {searching ? <Loader2 className="size-3.5 animate-spin" /> : 'Search'}
                </Button>
              </div>

              {result.candidates.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Is it one of these?</span>
                  {result.candidates.map(c => {
                    const key = `${c.retailer}:${c.externalId}`
                    return (
                      <div key={key} className="flex items-center gap-2.5 rounded-lg border p-2.5">
                        {c.imageUrl ? (
                          <img src={proxyImg(c.imageUrl)} alt="" className="size-10 shrink-0 rounded bg-muted object-contain" />
                        ) : (
                          <div className="size-10 shrink-0 rounded bg-muted" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-xs leading-snug">{c.title}</p>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <span className="size-2 rounded-full" style={{ background: RETAILER_COLORS[c.retailer] ?? '#10b981' }} />
                            <span className="text-[10px] text-muted-foreground">{result.labels[c.retailer] ?? c.retailer} · {fmt(c.priceCents)}</span>
                          </div>
                        </div>
                        <Button size="sm" variant="outline" disabled={trackingKey === key} onClick={() => void track(c)}>
                          {trackingKey === key ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                        </Button>
                      </div>
                    )
                  })}
                </div>
              ) : !identifying && (
                <p className="text-xs text-muted-foreground">No matches yet — refine the search above.</p>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
