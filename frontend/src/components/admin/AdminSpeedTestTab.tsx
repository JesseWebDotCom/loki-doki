import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { Spinner } from '@/components/ui/spinner'
import { DEFAULT_THRESHOLDS, RATING_META, fmtMbps, normalizeThresholds, type SpeedThresholds } from '@/lib/speedtest'

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { credentials: 'include', ...options })
    if (!r.ok) return null
    return await r.json() as T
  } catch { return null }
}

export function AdminSpeedTestTab() {
  const [thresholds, setThresholds] = useState<SpeedThresholds>(DEFAULT_THRESHOLDS)
  const [goodStr, setGoodStr] = useState(String(DEFAULT_THRESHOLDS.goodMbps))
  const [okStr, setOkStr] = useState(String(DEFAULT_THRESHOLDS.okMbps))
  const [saving, setSaving] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    apiFetch<SpeedThresholds>('/api/admin/speedtest').then((t) => {
      if (!t) return
      const normalized = normalizeThresholds(t)
      setThresholds(normalized)
      setGoodStr(String(normalized.goodMbps))
      setOkStr(String(normalized.okMbps))
    })
  }, [])

  const commit = useCallback((nextGood: string, nextOk: string) => {
    const t = normalizeThresholds({ goodMbps: parseFloat(nextGood), okMbps: parseFloat(nextOk) })
    setThresholds(t)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaving(true)
    saveTimer.current = setTimeout(async () => {
      const result = await apiFetch('/api/admin/speedtest', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(t),
      })
      setSaving(false)
      if (result) toast.success('Speed thresholds saved')
      else toast.error('Failed to save thresholds')
    }, 600)
  }, [])

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  const bands = [
    { rating: 'good' as const, range: `${fmtMbps(thresholds.goodMbps)} Mbps and up` },
    { rating: 'ok' as const,   range: `${fmtMbps(thresholds.okMbps)} – ${fmtMbps(thresholds.goodMbps)} Mbps` },
    { rating: 'bad' as const,  range: `Below ${fmtMbps(thresholds.okMbps)} Mbps` },
  ]

  return (
    <div className="space-y-4 p-4">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Color-code Speed Test results and the home widget against these download speed thresholds.
            Applies to all users.
          </p>
          {saving && <Spinner size="sm" />}
        </div>

        <div className="mt-3 space-y-2">
          <ThresholdRow
            color={RATING_META.good.color} label="Good (green)"
            help="At or above this is rated good."
            value={goodStr} onChange={(v) => { setGoodStr(v); commit(v, okStr) }}
          />
          <ThresholdRow
            color={RATING_META.ok.color} label="OK (yellow)"
            help="At or above this (but below good) is rated OK. Below is slow."
            value={okStr} onChange={(v) => { setOkStr(v); commit(goodStr, v) }}
          />
        </div>
      </div>

      <div className="rounded-card border border-border/50 bg-muted/30 p-3">
        <p className="mb-2 text-overline text-muted-foreground/55">Rating bands</p>
        <div className="space-y-1.5">
          {bands.map((b) => (
            <div key={b.rating} className="flex items-center gap-3">
              <span className="size-2.5 rounded-full" style={{ background: RATING_META[b.rating].color }} />
              <span className={cn('w-10 text-xs font-bold', RATING_META[b.rating].text)}>{RATING_META[b.rating].label}</span>
              <span className="text-xs text-muted-foreground">{b.range}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ThresholdRow({ color, label, help, value, onChange }: {
  color: string; label: string; help: string; value: string; onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-card border border-border/50 bg-card p-3">
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: color }} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold">{label}</p>
        <p className="text-[10px] text-muted-foreground/60">{help}</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <input
          type="number" inputMode="decimal" min={0} step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            'w-20 rounded-control border border-border/60 bg-muted/40 px-2 py-1.5 text-sm font-semibold tabular-nums text-right',
            'transition-colors focus:border-brand/60 focus:outline-none focus:ring-1 focus:ring-brand/50',
          )}
        />
        <span className="text-xs font-medium text-muted-foreground">Mbps</span>
      </div>
    </div>
  )
}
