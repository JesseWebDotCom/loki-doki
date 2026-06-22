import { useEffect, useState } from 'react'
import {
  Loader2, CheckCircle2, ChevronRight, Sparkles, WifiOff, AlertTriangle,
  Library, GraduationCap, Wrench, Code, BookOpen, Stethoscope, FlaskConical, Tent,
  Clapperboard, Baby, BookMarked, Globe, Map as MapIcon, MapPin, ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import { CompanionOrb } from '@/components/companion/CompanionOrb'
import { BrandMark } from '@/components/shared/BrandMark'

// ── Post-boot offline-content wizard ────────────────────────────────────────────
// Shown once, full-screen, after the app first boots. SetupWizard only installs
// essentials; here the admin picks the heavy optional content (ZIM archives, maps,
// home-inventory OCR) which downloads via the durable background job queue.

// ── ZIM types ─────────────────────────────────────────────────────────────────

interface ZimVariant { key: string; label: string; approxBytes: number; description: string }
interface ZimEntry {
  sourceId: string; label: string; description: string; category: string
  variants: ZimVariant[]; variantKey: string; installed: boolean; fileSizeBytes: number | null
}
interface ZimSelection { sourceId: string; variantKey: string; label: string; approxBytes: number }

const CATEGORY_VISUALS: Record<string, { icon: React.ComponentType<{ className?: string }>; chip: string }> = {
  Reference:     { icon: Library,        chip: 'bg-amber-500/15 text-amber-400' },
  Education:     { icon: GraduationCap,  chip: 'bg-blue-500/15 text-blue-400' },
  'How-To':      { icon: Wrench,         chip: 'bg-orange-500/15 text-orange-400' },
  Development:   { icon: Code,           chip: 'bg-violet-500/15 text-violet-400' },
  Books:         { icon: BookOpen,       chip: 'bg-rose-500/15 text-rose-400' },
  Medical:       { icon: Stethoscope,    chip: 'bg-red-500/15 text-red-400' },
  Science:       { icon: FlaskConical,   chip: 'bg-teal-500/15 text-teal-400' },
  Survival:      { icon: Tent,           chip: 'bg-green-500/15 text-green-400' },
  Entertainment: { icon: Clapperboard,   chip: 'bg-fuchsia-500/15 text-fuchsia-400' },
  Kids:          { icon: Baby,           chip: 'bg-yellow-500/15 text-yellow-500' },
  Religion:      { icon: BookMarked,     chip: 'bg-indigo-500/15 text-indigo-400' },
  _default:      { icon: Globe,          chip: 'bg-slate-500/15 text-slate-400' },
}

function formatBytes(b: number): string {
  if (b <= 0) return '-'
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(0)} MB`
  return `${(b / 1_073_741_824).toFixed(1)} GB`
}

const VALUE_PROPS = [
  { icon: ShieldCheck, text: 'Everything stays on your server — no cloud' },
  { icon: WifiOff,     text: 'Works without an internet connection' },
  { icon: Library,     text: 'Add or change any of this later in Admin' },
]

// ── Maps auto-detect ──────────────────────────────────────────────────────────

interface MapsCatalogRegion { region_id: string; label: string; parent_id: string | null; bbox: [number, number, number, number] }

function flattenMapsRegions(nodes: (MapsCatalogRegion & { children?: unknown[] })[]): MapsCatalogRegion[] {
  const out: MapsCatalogRegion[] = []
  const walk = (ns: (MapsCatalogRegion & { children?: unknown[] })[]) => {
    for (const n of ns) { out.push(n); if (Array.isArray(n.children)) walk(n.children as (MapsCatalogRegion & { children?: unknown[] })[]) }
  }
  walk(nodes)
  return out
}

function detectStateRegion(regions: MapsCatalogRegion[], lat: number, lng: number): { regionId: string; label: string } | null {
  const matches = regions.filter(r =>
    r.region_id.startsWith('us-') && Array.isArray(r.bbox) &&
    lng >= r.bbox[0] && lng <= r.bbox[2] && lat >= r.bbox[1] && lat <= r.bbox[3],
  )
  if (!matches.length) return null
  matches.sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]))
  return { regionId: matches[0]!.region_id, label: matches[0]!.label }
}

const primaryBtn = 'flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50 transition-colors'

// ── Wizard ────────────────────────────────────────────────────────────────────

export function WelcomeWizard({ onComplete }: { onComplete: () => void }) {
  const { user } = useAuth()
  const userId = user?.id ?? ''

  const [catalog, setCatalog]         = useState<ZimEntry[] | null>(null)
  const [zimSelected, setZimSelected] = useState<Map<string, string>>(new Map())
  const [expandedCat, setExpandedCat] = useState<string | null>(null)
  const [mapsRegion, setMapsRegion]   = useState<{ regionId: string; label: string } | null>(null)
  const [mapsOn, setMapsOn]           = useState(false)
  const [diskFreeBytes, setDiskFreeBytes] = useState(0)
  const [finishing, setFinishing]     = useState(false)
  const [error, setError]             = useState('')

  useEffect(() => {
    fetch('/api/admin/archives/catalog', { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((data: { catalog?: ZimEntry[] }) => setCatalog((data.catalog ?? []).filter(e => !e.installed)))
      .catch(() => setCatalog([]))
  }, [])

  useEffect(() => {
    fetch('/api/setup/catalog', { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: { disk?: { freeBytes?: number } }) => setDiskFreeBytes(d.disk?.freeBytes ?? 0))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!userId) return
    Promise.all([
      fetch(`/api/users/${userId}/preferences`, { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/admin/maps/catalog', { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([prefs, cat]) => {
      const loc = prefs?.['user.location'] as { lat?: number; lng?: number } | undefined
      if (!loc?.lat || !loc?.lng || !cat?.regions) return
      const region = detectStateRegion(flattenMapsRegions(cat.regions), loc.lat, loc.lng)
      if (region) { setMapsRegion(region); setMapsOn(true) }
    }).catch(() => {})
  }, [userId])

  function toggleZim(entry: ZimEntry) {
    setZimSelected(prev => {
      const next = new Map(prev)
      if (next.has(entry.sourceId)) next.delete(entry.sourceId)
      else next.set(entry.sourceId, entry.variantKey || entry.variants[0]?.key || 'maxi')
      return next
    })
  }
  function setVariant(sourceId: string, variantKey: string) {
    setZimSelected(prev => { const next = new Map(prev); if (next.has(sourceId)) next.set(sourceId, variantKey); return next })
  }
  function toggleCategory(entries: ZimEntry[]) {
    setZimSelected(prev => {
      const next = new Map(prev)
      const allIn = entries.every(e => next.has(e.sourceId))
      if (allIn) { for (const e of entries) next.delete(e.sourceId) }
      else { for (const e of entries) if (!next.has(e.sourceId)) next.set(e.sourceId, e.variantKey || e.variants[0]?.key || 'maxi') }
      return next
    })
  }

  const byCategory = new Map<string, ZimEntry[]>()
  for (const e of catalog ?? []) { const c = e.category || 'Other'; (byCategory.get(c) ?? byCategory.set(c, []).get(c)!).push(e) }

  const zimBytes = [...zimSelected].reduce((sum, [sourceId, vk]) => {
    const entry   = catalog?.find(e => e.sourceId === sourceId)
    const variant = entry?.variants.find(v => v.key === vk)
    return sum + (variant?.approxBytes ?? 0)
  }, 0)
  const mapsBytes  = mapsOn && mapsRegion ? 480_000_000 : 0
  const totalBytes = zimBytes + mapsBytes
  const freeAfter  = Math.max(0, diskFreeBytes - totalBytes)
  const notEnough  = diskFreeBytes > 0 && totalBytes > diskFreeBytes * 0.95
  const anySelected = zimSelected.size > 0 || (mapsOn && !!mapsRegion)

  async function finish(enqueue: boolean) {
    setFinishing(true); setError('')
    try {
      if (enqueue && anySelected) {
        const zimSelections: ZimSelection[] = []
        for (const [sourceId, variantKey] of zimSelected) {
          const entry = catalog?.find(e => e.sourceId === sourceId)
          if (!entry) continue
          const variant = entry.variants.find(v => v.key === variantKey) ?? entry.variants[0]
          zimSelections.push({ sourceId, variantKey, label: entry.label, approxBytes: variant?.approxBytes ?? 0 })
        }
        const maps = mapsOn && mapsRegion ? { regionId: mapsRegion.regionId, label: mapsRegion.label } : null
        await fetch('/api/jobs/enqueue', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ componentIds: [], zimSelections, maps }),
        })
      }
      await fetch('/api/setup/welcome-complete', { method: 'POST', credentials: 'include' })
      onComplete()
    } catch {
      setError('Could not save your choices. Please try again.')
      setFinishing(false)
    }
  }

  return (
    <div className="relative flex h-screen overflow-hidden bg-background">
      {/* Ambient glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-20 top-1/4 size-[600px] rounded-full bg-violet-600/10 blur-[150px]" />
        <div className="absolute right-0 bottom-0 size-[500px] rounded-full bg-blue-600/8 blur-[140px]" />
      </div>

      {/* ── Left pane: branding + orb + value-props (mirrors SetupWizard shell) ── */}
      <aside className="relative z-10 hidden w-[42%] max-w-md shrink-0 flex-col justify-between overflow-hidden border-r border-border/50 bg-gradient-to-b from-violet-950/30 via-background to-background px-10 py-10 lg:flex">
        <div className="flex items-center gap-3">
          <BrandMark glow className="size-10" />
          <div>
            <h1 className="text-xl font-black tracking-tight leading-none">LokiDoki</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Your private AI home hub</p>
          </div>
        </div>

        <div className="flex flex-col items-center gap-6 py-6">
          <CompanionOrb size={150} active seed="loki-doki-welcome" />
          <div className="space-y-2.5">
            {VALUE_PROPS.map(vp => (
              <div key={vp.text} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <vp.icon className="size-4 shrink-0 text-violet-400" />
                <span>{vp.text}</span>
              </div>
            ))}
          </div>
        </div>

        <div />
      </aside>

      {/* ── Right pane: all content (scrollable) ──────────────────────────────── */}
      <main className="relative z-10 flex h-screen flex-1 flex-col overflow-y-auto">
        {/* Mobile brand header */}
        <div className="flex items-center gap-2 border-b border-border/50 px-6 py-4 lg:hidden">
          <BrandMark className="size-8" />
          <span className="text-base font-black tracking-tight">LokiDoki</span>
        </div>

        <div className="flex flex-1 flex-col px-8 py-8">

          {/* Header */}
          <div className="mb-6">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-300 mb-3">
              <Sparkles className="size-3.5" /> You're all set up
            </span>
            <h2 className="text-2xl font-black tracking-tight">Add your offline content</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your AI is ready right now. Pick anything below and it downloads in the background while you explore.
            </p>
          </div>

          {/* ── Offline Library ────────────────────────────────────────────────── */}
          <section className="space-y-3 flex-1">
            <div className="flex items-center gap-2.5">
              <div className="flex size-7 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400"><Library className="size-4" /></div>
              <div>
                <h3 className="text-sm font-bold tracking-tight">Offline library</h3>
                <p className="text-xs text-muted-foreground">Wikipedia, repair guides, medical references and more — readable without internet.</p>
              </div>
            </div>

            {!catalog && (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading catalog…
              </div>
            )}
            {catalog && catalog.length === 0 && (
              <p className="rounded-xl border border-border bg-card px-4 py-5 text-center text-sm text-muted-foreground">
                All available archives are already installed.
              </p>
            )}
            {catalog && catalog.length > 0 && (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                  {[...byCategory.entries()].map(([category, entries]) => {
                    const allIn  = entries.every(e => zimSelected.has(e.sourceId))
                    const someIn = entries.some(e => zimSelected.has(e.sourceId))
                    const open   = expandedCat === category
                    const catBytes = entries.reduce((s, e) => {
                      const v = e.variants.find(x => x.key === e.variantKey) ?? e.variants[0]
                      return s + (v?.approxBytes ?? 0)
                    }, 0)
                    const vis  = CATEGORY_VISUALS[category] ?? CATEGORY_VISUALS['_default']!
                    const Icon = vis.icon
                    return (
                      <div key={category} onClick={() => toggleCategory(entries)}
                        className={cn('cursor-pointer rounded-xl border p-3 transition-colors',
                          someIn ? 'border-violet-500/40 bg-violet-500/[0.06]' : 'border-border bg-card hover:border-border/70',
                          open && 'ring-1 ring-violet-500/40')}>
                        <div className="flex items-start justify-between">
                          <div className={cn('flex size-8 items-center justify-center rounded-lg', vis.chip)}><Icon className="size-4" /></div>
                          <span className={cn('flex size-5 items-center justify-center rounded-full border-2 transition-all',
                            allIn || someIn ? 'border-violet-500 bg-violet-500' : 'border-border')}>
                            {allIn ? <CheckCircle2 className="size-3 text-white" /> : someIn ? <span className="h-0.5 w-2.5 rounded-full bg-white" /> : null}
                          </span>
                        </div>
                        <p className="mt-2 text-sm font-semibold leading-tight">{category}</p>
                        <p className="text-[11px] text-muted-foreground tabular-nums">
                          {entries.length} {entries.length === 1 ? 'item' : 'items'} · ~{formatBytes(catBytes)}
                        </p>
                        <button type="button" onClick={(e) => { e.stopPropagation(); setExpandedCat(open ? null : category) }}
                          className="mt-1 text-[11px] font-medium text-violet-400 hover:text-violet-300">
                          {open ? 'Hide' : 'Customize'}
                        </button>
                      </div>
                    )
                  })}
                </div>

                {expandedCat && byCategory.has(expandedCat) && (
                  <div className="rounded-xl border border-border bg-card p-3 animate-in fade-in slide-in-from-top-1 duration-150">
                    <div className="mb-1 flex items-center justify-between px-1">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{expandedCat}</p>
                      <button type="button" onClick={() => setExpandedCat(null)}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors">Done</button>
                    </div>
                    {byCategory.get(expandedCat)!.map(entry => {
                      const checked    = zimSelected.has(entry.sourceId)
                      const variantKey = zimSelected.get(entry.sourceId) ?? entry.variantKey
                      const variant    = entry.variants.find(v => v.key === variantKey) ?? entry.variants[0]
                      return (
                        <div key={entry.sourceId} className="flex items-center gap-3 py-1.5">
                          <button type="button" onClick={() => toggleZim(entry)}
                            className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all',
                              checked ? 'border-violet-500 bg-violet-500' : 'border-border bg-transparent hover:border-violet-400')}>
                            {checked && <CheckCircle2 className="size-3 text-white" />}
                          </button>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium leading-tight">{entry.label}</p>
                            <p className="text-xs text-muted-foreground leading-snug truncate">{entry.description}</p>
                          </div>
                          {checked && entry.variants.length > 1 ? (
                            <select value={variantKey} onChange={e => setVariant(entry.sourceId, e.target.value)}
                              className="shrink-0 rounded-lg border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500/40">
                              {entry.variants.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
                            </select>
                          ) : (
                            <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                              ~{formatBytes(variant?.approxBytes ?? 0)}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}

            {/* Maps */}
            {mapsRegion && (
              <div className="pt-1">
                <button type="button" onClick={() => setMapsOn(v => !v)}
                  className={cn('flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
                    mapsOn ? 'border-violet-500/40 bg-violet-500/[0.06]' : 'border-border bg-card hover:border-border/70')}>
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-green-500/15 text-green-400"><MapIcon className="size-4" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold tracking-tight">Offline maps</p>
                    <p className="text-xs text-muted-foreground truncate">
                      <MapPin className="mr-0.5 inline size-3 -translate-y-px" />{mapsRegion.label}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">~{formatBytes(480_000_000)}</span>
                  <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all',
                    mapsOn ? 'border-violet-500 bg-violet-500' : 'border-border')}>
                    {mapsOn && <CheckCircle2 className="size-3 text-white" />}
                  </span>
                </button>
              </div>
            )}
          </section>

          {/* ── Footer: disk stats + actions — matches ModelsStep card style ── */}
          <div className="mt-6 rounded-xl border border-border bg-card px-4 py-4 space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground tabular-nums">{formatBytes(totalBytes)}</span> to download
              </span>
              {diskFreeBytes > 0 && (
                <span className="text-muted-foreground">
                  <span className={cn('font-semibold tabular-nums', notEnough ? 'text-amber-400' : 'text-foreground')}>{formatBytes(freeAfter)}</span> free afterward
                </span>
              )}
              {notEnough ? (
                <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-amber-400">
                  <AlertTriangle className="size-3.5" /> Not enough space
                </span>
              ) : totalBytes > 0 ? (
                <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                  <CheckCircle2 className="size-3.5" /> Enough space
                </span>
              ) : null}
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <div className="flex items-center justify-between pt-1">
              <button type="button" disabled={finishing} onClick={() => finish(false)}
                className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors">
                Skip for now
              </button>
              <button type="button" disabled={finishing || notEnough} onClick={() => finish(true)} className={primaryBtn}>
                {finishing
                  ? <Loader2 className="size-4 animate-spin" />
                  : anySelected
                    ? <>Add &amp; open app <ChevronRight className="size-4" /></>
                    : <>Open app <ChevronRight className="size-4" /></>}
              </button>
            </div>
          </div>

        </div>
      </main>
    </div>
  )
}
