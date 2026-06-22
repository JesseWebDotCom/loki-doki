import { useEffect, useState, useCallback } from 'react'
import { RefreshCw, Loader2, Newspaper } from 'lucide-react'
import { cn } from '@/lib/cn'

// ── Types (mirror backend lib/briefing/settings.ts) ──────────────────────────────
type SourceId = 'weather' | 'worldNews' | 'localNews' | 'localEvents' | 'sports' | 'onThisDay' | 'notableDeaths' | 'holidays'

interface BriefingSettings {
  enabled: boolean
  sources: Record<SourceId, boolean>
  cadenceMinutes: number
  patchSlug: string | null
  defaultLocation: string
  maxItems: { localNews: number; localEvents: number; worldNews: number; sports: number }
}

interface CachedSnapshot {
  key: string
  location: string | null
  generatedAt: number | null
  degraded: string[]
  blockChars: number
}

const SOURCE_LABELS: Record<SourceId, string> = {
  weather: 'Weather',
  worldNews: 'World news',
  localNews: 'Local news (Patch)',
  localEvents: 'Local events (Patch)',
  sports: 'Sports scores',
  onThisDay: 'On this day + birthdays',
  notableDeaths: 'Notable deaths',
  holidays: 'Holidays',
}
const SOURCE_ORDER: SourceId[] = ['weather', 'localNews', 'localEvents', 'sports', 'worldNews', 'notableDeaths', 'onThisDay', 'holidays']

const inputCls = 'rounded-xl border border-border bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/40'

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'relative shrink-0 h-5 w-9 rounded-full transition-colors duration-200',
        checked ? 'bg-brand' : 'bg-foreground/15',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span className={cn('absolute top-[2px] size-4 rounded-full bg-white shadow-sm transition-transform', checked ? 'left-[18px]' : 'left-[2px]')} />
    </button>
  )
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 mb-3 mt-4">
      <span className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground/40 shrink-0">{label}</span>
      <div className="h-px flex-1 bg-border/40" />
    </div>
  )
}

export function AdminBriefingTab() {
  const [settings, setSettings] = useState<BriefingSettings | null>(null)
  const [cached, setCached] = useState<CachedSnapshot[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [preview, setPreview] = useState<{ block: string; degraded: string[] } | null>(null)

  const load = useCallback(async () => {
    const r = await fetch('/api/admin/briefing', { credentials: 'include' })
    if (!r.ok) return
    const data = (await r.json()) as { settings: BriefingSettings; cached: CachedSnapshot[] }
    setSettings(data.settings)
    setCached(data.cached)
  }, [])

  useEffect(() => { void load() }, [load])

  const put = useCallback(async (key: string, value: unknown) => {
    await fetch('/api/admin/briefing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ key, value }),
    })
  }, [])

  const refreshNow = useCallback(async () => {
    setRefreshing(true)
    setPreview(null)
    try {
      const r = await fetch('/api/admin/briefing/refresh-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      })
      if (r.ok) {
        const data = (await r.json()) as { block: string; payload: { degraded: string[] } }
        setPreview({ block: data.block, degraded: data.payload.degraded })
        await load()
      }
    } finally {
      setRefreshing(false)
    }
  }, [load])

  if (!settings) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground p-4"><Loader2 className="size-4 animate-spin" /> Loading…</div>
  }

  const s = settings
  const update = (patch: Partial<BriefingSettings>) => setSettings({ ...s, ...patch })

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Header row with title + enable toggle */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-violet-500/15 text-violet-500 p-2"><Newspaper className="size-5" /></div>
          <div>
            <h2 className="text-lg font-semibold">Daily Briefing</h2>
            <p className="text-xs text-muted-foreground">Ambient world &amp; local context woven into companion replies.</p>
          </div>
        </div>
        <Toggle checked={s.enabled} onChange={(v) => { update({ enabled: v }); void put('enabled', v) }} />
      </div>

      {/* 2-column body */}
      <div className={cn('grid grid-cols-2 gap-6 min-h-0', !s.enabled && 'opacity-50 pointer-events-none')}>
        {/* Left: sources */}
        <div>
          <SectionHeader label="Sources" />
          <div className="rounded-xl border border-border divide-y divide-border/60">
            {SOURCE_ORDER.map((id) => (
              <div key={id} className="flex items-center justify-between px-4 py-2.5">
                <span className="text-sm">{SOURCE_LABELS[id]}</span>
                <Toggle
                  checked={s.sources[id]}
                  onChange={(v) => { update({ sources: { ...s.sources, [id]: v } }); void put(`source.${id}`, v) }}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Local sources use Patch ({s.patchSlug || 'auto-derived from location'}) with a web-search fallback.
            Sports uses ESPN's public scoreboard.
          </p>
        </div>

        {/* Right: location + limits + preview */}
        <div>
          <SectionHeader label="Location" />
          <div className="space-y-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Default location (users with none set)
              <input
                className={inputCls}
                defaultValue={s.defaultLocation}
                placeholder="Milford, CT"
                onBlur={(e) => { const v = e.target.value.trim(); update({ defaultLocation: v }); void put('default_location', v) }}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Patch town slug override
              <input
                className={inputCls}
                defaultValue={s.patchSlug ?? ''}
                placeholder="connecticut/milford"
                onBlur={(e) => { const v = e.target.value.trim(); update({ patchSlug: v || null }); void put('patch_slug', v) }}
              />
            </label>
          </div>

          <SectionHeader label="Refresh &amp; limits" />
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Cadence (min)
              <input type="number" min={30} className={inputCls} defaultValue={s.cadenceMinutes}
                onBlur={(e) => { const v = Math.max(30, Number(e.target.value) || 150); update({ cadenceMinutes: v }); void put('cadence_minutes', v) }} />
            </label>
            {(['localNews', 'localEvents', 'worldNews', 'sports'] as const).map((k) => (
              <label key={k} className="flex flex-col gap-1 text-xs text-muted-foreground">
                Max {k} items
                <input type="number" min={0} max={6} className={inputCls} defaultValue={s.maxItems[k]}
                  onBlur={(e) => { const v = Math.max(0, Math.min(6, Number(e.target.value) || 0)); update({ maxItems: { ...s.maxItems, [k]: v } }); void put(`max_items.${k}`, v) }} />
              </label>
            ))}
          </div>

          <SectionHeader label="Preview" />
          <button
            type="button"
            onClick={() => void refreshNow()}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-xl bg-brand text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Refresh now
          </button>
          {preview && (
            <div className="mt-3">
              {preview.degraded.length > 0 && (
                <div className="text-xs text-amber-500 mb-1">Degraded this run: {preview.degraded.join(', ')}</div>
              )}
              <pre className="whitespace-pre-wrap rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground">
                {preview.block || '(empty — briefing disabled or nothing to show)'}
              </pre>
            </div>
          )}

          {cached.length > 0 && (
            <>
              <SectionHeader label="Cached locations" />
              <div className="rounded-xl border border-border divide-y divide-border/60 text-xs">
                {cached.map((c) => (
                  <div key={c.key} className="flex items-center justify-between px-4 py-2">
                    <span className="font-medium">{c.location ?? c.key}</span>
                    <span className="text-muted-foreground">
                      {c.generatedAt ? new Date(c.generatedAt).toLocaleTimeString() : '—'} · {c.blockChars} chars
                      {c.degraded.length ? ` · degraded: ${c.degraded.join(',')}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
