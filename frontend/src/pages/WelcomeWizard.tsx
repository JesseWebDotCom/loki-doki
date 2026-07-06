import { useEffect, useState } from 'react'
import {
  CheckCircle2, ChevronRight, Sparkles, WifiOff, AlertTriangle,
  Library, GraduationCap, Wrench, Code, BookOpen, Stethoscope, FlaskConical, Tent,
  Clapperboard, Baby, BookMarked, Globe, Map as MapIcon, MapPin, ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import { CompanionOrb } from '@/components/companion/CompanionOrb'
import { BrandMark } from '@/components/shared/BrandMark'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

// ── Post-boot offline-content wizard ────────────────────────────────────────────
// Shown once, full-screen, after the app first boots. SetupWizard only installs
// essentials; here the admin picks the heavy optional content (ZIM archives, maps,
// home-inventory OCR) which downloads via the durable background job queue.

// ── ZIM types ─────────────────────────────────────────────────────────────────

interface ZimVariant { key: string; label: string; approxBytes: number; description: string }
interface ZimEntry {
  sourceId: string; label: string; description: string; category: string
  bookCategory: string | null
  variants: ZimVariant[]; variantKey: string; installed: boolean; fileSizeBytes: number | null
}
interface ZimSelection { sourceId: string; variantKey: string; label: string; approxBytes: number }

const CATEGORY_VISUALS: Record<string, { icon: React.ComponentType<{ className?: string }>; chip: string }> = {
  Reference:     { icon: Library,        chip: 'bg-info/15 text-info' },
  Education:     { icon: GraduationCap,  chip: 'bg-brand/15 text-brand' },
  'How-To':      { icon: Wrench,         chip: 'bg-warning/15 text-warning' },
  Development:   { icon: Code,           chip: 'bg-brand/15 text-brand' },
  Books:         { icon: BookOpen,       chip: 'bg-info/15 text-info' },
  'Fiction & Classics':  { icon: BookOpen, chip: 'bg-info/15 text-info' },
  'Classics & Texts':    { icon: BookOpen, chip: 'bg-info/15 text-info' },
  Textbooks:             { icon: BookOpen, chip: 'bg-info/15 text-info' },
  'Manuals & Survival':  { icon: Wrench,   chip: 'bg-warning/15 text-warning' },
  Medical:       { icon: Stethoscope,    chip: 'bg-destructive/15 text-destructive' },
  Science:       { icon: FlaskConical,   chip: 'bg-success/15 text-success' },
  Survival:      { icon: Tent,           chip: 'bg-success/15 text-success' },
  Entertainment: { icon: Clapperboard,   chip: 'bg-brand/15 text-brand' },
  Kids:          { icon: Baby,           chip: 'bg-warning/15 text-warning' },
  Religion:      { icon: BookMarked,     chip: 'bg-info/15 text-info' },
  _default:      { icon: Globe,          chip: 'bg-secondary text-muted-foreground' },
}

function formatBytes(b: number): string {
  if (b <= 0) return '-'
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(0)} MB`
  return `${(b / 1_073_741_824).toFixed(1)} GB`
}

// Curated "recommended for a home hub" set, pre-selected on this step and shown in its own
// section above the full catalog. Each entry pins a specific variant: the general-knowledge
// anchor (Wikipedia Mini) plus small, high-value references for health, world facts, kids,
// emergencies, travel, and repairs. Items already installed or absent from the live catalog
// are skipped. Array order is the display order. Users can uncheck any of them.
const RECOMMENDED: { sourceId: string; variantKey: string }[] = [
  { sourceId: 'wikipedia',       variantKey: 'mini' },
  { sourceId: 'wikimed',         variantKey: 'en' },
  { sourceId: 'factbook',        variantKey: 'en' },
  { sourceId: 'vikidia',         variantKey: 'en' },
  { sourceId: 'zimgit_medicine', variantKey: 'en' },
  { sourceId: 'ready_gov',       variantKey: 'en' },
  { sourceId: 'wikivoyage',      variantKey: 'maxi' },
  { sourceId: 'ifixit',          variantKey: 'en' },
]

const VALUE_PROPS = [
  { icon: ShieldCheck, text: 'Everything stays on your server - no cloud' },
  { icon: WifiOff,     text: 'Works without an internet connection' },
  { icon: Library,     text: 'Change any of this later in the Admin panel' },
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
      .then((data: { catalog?: ZimEntry[] }) => {
        const avail = (data.catalog ?? []).filter(e => !e.installed)
        setCatalog(avail)
        // Pre-select the recommended set (only items actually available), each at its
        // recommended variant, falling back to the catalog default if that key is gone.
        const seed = new Map<string, string>()
        for (const rec of RECOMMENDED) {
          const entry = avail.find(e => e.sourceId === rec.sourceId)
          if (!entry) continue
          const vk = entry.variants.some(v => v.key === rec.variantKey)
            ? rec.variantKey
            : (entry.variantKey || entry.variants[0]?.key || 'maxi')
          seed.set(entry.sourceId, vk)
        }
        if (seed.size) setZimSelected(seed)
      })
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

  // Split the catalog into Books (has bookCategory) and Reference (everything else).
  // Keys are namespaced ("b:Textbooks" / "r:Medical") so groups that share a name across
  // both sides (Kids, Religion) don't collide in the single expandedCat state.
  // Recommended items are surfaced in their own section above, so keep them out of the
  // category buckets to avoid showing each one twice. Preserve RECOMMENDED order for display.
  const recommendedIds = new Set(RECOMMENDED.map(r => r.sourceId))
  const recommendedEntries = RECOMMENDED
    .map(r => (catalog ?? []).find(e => e.sourceId === r.sourceId))
    .filter((e): e is ZimEntry => !!e)

  const byCategory = new Map<string, ZimEntry[]>()
  const bookKeys: string[] = []
  const refKeys: string[] = []
  for (const e of catalog ?? []) {
    if (recommendedIds.has(e.sourceId)) continue
    const isBook = !!e.bookCategory
    const label = (isBook ? e.bookCategory : e.category) || 'Other'
    const key = `${isBook ? 'b' : 'r'}:${label}`
    if (!byCategory.has(key)) { byCategory.set(key, []); (isBook ? bookKeys : refKeys).push(key) }
    byCategory.get(key)!.push(e)
  }
  bookKeys.sort(); refKeys.sort()

  function renderPackBucket(title: string, keys: string[]) {
    if (!keys.length) return null
    return (
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {keys.map((key) => {
            const entries = byCategory.get(key)!
            const label  = key.slice(2)
            const allIn  = entries.every(e => zimSelected.has(e.sourceId))
            const someIn = entries.some(e => zimSelected.has(e.sourceId))
            const open   = expandedCat === key
            const catBytes = entries.reduce((s, e) => {
              const v = e.variants.find(x => x.key === e.variantKey) ?? e.variants[0]
              return s + (v?.approxBytes ?? 0)
            }, 0)
            const vis  = CATEGORY_VISUALS[label] ?? CATEGORY_VISUALS['_default']!
            const Icon = vis.icon
            return (
              <div key={key} onClick={() => toggleCategory(entries)}
                className={cn('cursor-pointer rounded-card border p-3 transition-colors',
                  someIn ? 'border-brand/40 bg-brand/[0.06]' : 'border-border bg-card hover:border-border/70',
                  open && 'ring-1 ring-brand/40')}>
                <div className="flex items-start justify-between">
                  <div className={cn('flex size-8 items-center justify-center rounded-control', vis.chip)}><Icon className="size-4" /></div>
                  <span className={cn('flex size-5 items-center justify-center rounded-full border-2 transition-all',
                    allIn || someIn ? 'border-brand bg-brand' : 'border-border')}>
                    {allIn ? <CheckCircle2 className="size-3 text-brand-foreground" /> : someIn ? <span className="h-0.5 w-2.5 rounded-full bg-brand-foreground" /> : null}
                  </span>
                </div>
                <p className="mt-2 text-sm font-semibold leading-tight">{label}</p>
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {entries.length} {entries.length === 1 ? 'item' : 'items'} · ~{formatBytes(catBytes)}
                </p>
                <button type="button" onClick={(e) => { e.stopPropagation(); setExpandedCat(open ? null : key) }}
                  className="mt-1 text-[11px] font-medium text-brand hover:text-brand/80">
                  {open ? 'Hide' : 'Customize'}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  const zimBytes = [...zimSelected].reduce((sum, [sourceId, vk]) => {
    const entry   = catalog?.find(e => e.sourceId === sourceId)
    const variant = entry?.variants.find(v => v.key === vk)
    return sum + (variant?.approxBytes ?? 0)
  }, 0)
  const mapsBytes   = mapsOn && mapsRegion ? 480_000_000 : 0
  const totalBytes  = zimBytes + mapsBytes
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
          body: JSON.stringify({ zimSelections, maps }),
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
      {/* Ambient glow: absolute (not fixed) so it stays contained to this full-screen shell,
          same decorative treatment as BootScreen. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-20 top-1/4 size-[600px] rounded-full bg-brand/10 blur-[150px]" />
        <div className="absolute right-0 bottom-0 size-[500px] rounded-full bg-brand/6 blur-[140px]" />
      </div>

      {/* ── Left pane: branding + orb + value-props (mirrors SetupWizard shell) ── */}
      <aside className="relative z-10 hidden w-[42%] max-w-md shrink-0 flex-col justify-between overflow-hidden border-r border-border/50 bg-gradient-to-b from-brand/[0.08] via-background to-background px-10 py-10 lg:flex">
        <div className="flex items-center gap-3">
          <BrandMark glow className="size-10" />
          <div>
            {/* design-ok(raw-h1-in-pages): compact brand wordmark next to the logo mark, mirrors BootScreen */}
            <h1 className="text-xl font-bold tracking-tight leading-none">Loki Doki</h1>
            <p className="text-xs text-muted-foreground mt-0.5">Your private AI home hub</p>
          </div>
        </div>

        <div className="flex flex-col items-center gap-6 py-6">
          <CompanionOrb size={150} active seed="loki-doki-welcome" />
          <div className="space-y-2.5">
            {VALUE_PROPS.map(vp => (
              <div key={vp.text} className="flex items-center gap-2.5 text-sm text-muted-foreground">
                <vp.icon className="size-4 shrink-0 text-brand" />
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
          <span className="text-base font-bold tracking-tight">Loki Doki</span>
        </div>

        <div className="flex flex-1 flex-col px-8 py-8">

          {/* Header */}
          <div className="mb-6">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-xs font-semibold text-brand mb-3">
              <Sparkles className="size-3.5" /> You're all set up
            </span>
            <h2 className="text-title">Add books & references for offline</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your AI is ready right now. Pick any books and references to keep on hand - they download in the background while you explore.
            </p>
          </div>

          {/* ── Offline Library ────────────────────────────────────────────────── */}
          <section className="space-y-3 flex-1">
            <div className="flex items-center gap-2.5">
              <div className="flex size-7 items-center justify-center rounded-control bg-warning/15 text-warning"><Library className="size-4" /></div>
              <div>
                <h3 className="text-sm font-bold tracking-tight">Books & references</h3>
                <p className="text-xs text-muted-foreground">Whole book collections plus Wikipedia, medical and repair references - readable without internet.</p>
              </div>
            </div>

            {!catalog && (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Spinner /> Loading catalog…
              </div>
            )}
            {catalog && catalog.length === 0 && (
              <p className="rounded-card border border-border bg-card px-4 py-5 text-center text-sm text-muted-foreground">
                All available archives are already installed.
              </p>
            )}
            {catalog && catalog.length > 0 && (
              <>
                {recommendedEntries.length > 0 && (
                  <div className="rounded-card border border-brand/30 bg-brand/[0.05] p-3">
                    <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1">
                      <Sparkles className="size-4 text-brand" />
                      <p className="text-sm font-bold tracking-tight">Recommended for your home</p>
                      <span className="text-[11px] text-muted-foreground">pre-selected - uncheck anything you don't want</span>
                    </div>
                    {recommendedEntries.map(entry => {
                      const checked    = zimSelected.has(entry.sourceId)
                      const variantKey = zimSelected.get(entry.sourceId) ?? entry.variantKey
                      const variant    = entry.variants.find(v => v.key === variantKey) ?? entry.variants[0]
                      return (
                        <div key={entry.sourceId} className="flex items-center gap-3 py-1.5">
                          <button type="button" onClick={() => toggleZim(entry)}
                            className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all',
                              checked ? 'border-brand bg-brand' : 'border-border bg-transparent hover:border-brand/60')}>
                            {checked && <CheckCircle2 className="size-3 text-brand-foreground" />}
                          </button>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium leading-tight">{entry.label}</p>
                            <p className="text-xs text-muted-foreground leading-snug truncate">{entry.description}</p>
                          </div>
                          {checked && entry.variants.length > 1 ? (
                            <select value={variantKey} onChange={e => setVariant(entry.sourceId, e.target.value)}
                              className="shrink-0 rounded-control border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand/40">
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
                {renderPackBucket('Books', bookKeys)}
                {renderPackBucket('Reference', refKeys)}

                {expandedCat && byCategory.has(expandedCat) && (
                  <div className="rounded-card border border-border bg-card p-3 animate-in fade-in slide-in-from-top-1 duration-150">
                    <div className="mb-1 flex items-center justify-between px-1">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{expandedCat.slice(2)}</p>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setExpandedCat(null)} className="text-muted-foreground">Done</Button>
                    </div>
                    {byCategory.get(expandedCat)!.map(entry => {
                      const checked    = zimSelected.has(entry.sourceId)
                      const variantKey = zimSelected.get(entry.sourceId) ?? entry.variantKey
                      const variant    = entry.variants.find(v => v.key === variantKey) ?? entry.variants[0]
                      return (
                        <div key={entry.sourceId} className="flex items-center gap-3 py-1.5">
                          <button type="button" onClick={() => toggleZim(entry)}
                            className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all',
                              checked ? 'border-brand bg-brand' : 'border-border bg-transparent hover:border-brand/60')}>
                            {checked && <CheckCircle2 className="size-3 text-brand-foreground" />}
                          </button>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium leading-tight">{entry.label}</p>
                            <p className="text-xs text-muted-foreground leading-snug truncate">{entry.description}</p>
                          </div>
                          {checked && entry.variants.length > 1 ? (
                            <select value={variantKey} onChange={e => setVariant(entry.sourceId, e.target.value)}
                              className="shrink-0 rounded-control border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand/40">
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
                  className={cn('flex w-full items-center gap-3 rounded-card border px-4 py-3 text-left transition-colors',
                    mapsOn ? 'border-brand/40 bg-brand/[0.06]' : 'border-border bg-card hover:border-border/70')}>
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-control bg-success/15 text-success"><MapIcon className="size-4" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold tracking-tight">Offline maps</p>
                    <p className="text-xs text-muted-foreground truncate">
                      <MapPin className="mr-0.5 inline size-3 -translate-y-px" />{mapsRegion.label}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">~{formatBytes(480_000_000)}</span>
                  <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-all',
                    mapsOn ? 'border-brand bg-brand' : 'border-border')}>
                    {mapsOn && <CheckCircle2 className="size-3 text-brand-foreground" />}
                  </span>
                </button>
              </div>
            )}
          </section>

          {/* ── Footer: disk stats + actions, matches ModelsStep card style ── */}
          <div className="mt-6 rounded-card border border-border bg-card px-4 py-4 space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-muted-foreground">
                <span className="font-semibold text-foreground tabular-nums">{formatBytes(totalBytes)}</span> to download
              </span>
              {diskFreeBytes > 0 && (
                <span className="text-muted-foreground">
                  <span className={cn('font-semibold tabular-nums', notEnough ? 'text-warning' : 'text-foreground')}>{formatBytes(freeAfter)}</span> free afterward
                </span>
              )}
              {notEnough ? (
                <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-warning">
                  <AlertTriangle className="size-3.5" /> Not enough space
                </span>
              ) : totalBytes > 0 ? (
                <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-success">
                  <CheckCircle2 className="size-3.5" /> Enough space
                </span>
              ) : null}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex items-center justify-between pt-1">
              <Button type="button" variant="ghost" size="sm" disabled={finishing} onClick={() => finish(false)} className="text-muted-foreground">
                Skip for now
              </Button>
              <Button type="button" disabled={finishing || notEnough} onClick={() => finish(true)} size="xl">
                {finishing
                  ? <Spinner className="text-current" />
                  : anySelected
                    ? <>Add &amp; open app <ChevronRight className="size-4" /></>
                    : <>Open app <ChevronRight className="size-4" /></>}
              </Button>
            </div>
          </div>

        </div>
      </main>
    </div>
  )
}
