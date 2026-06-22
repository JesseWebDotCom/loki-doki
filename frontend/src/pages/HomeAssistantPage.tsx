import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useBreadcrumbSearch } from '@/context/BreadcrumbSearchContext'
import {
  Home,
  Lightbulb,
  Power,
  Wind,
  Lock,
  Thermometer,
  Volume2,
  ChevronRight,
  Loader2,
  WifiOff,
  BedDouble,
  ChefHat,
  Tv2,
  Monitor,
  Car,
  TreePine,
  DoorOpen,
  UtensilsCrossed,
  Waves,
} from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'

// ── Types ────────────────────────────────────────────────────────────────────

interface HAEntity {
  entity_id: string
  state: string
  friendly_name: string
  domain: string
  area?: string
}

interface EntitiesResponse {
  configured: boolean
  entities?: HAEntity[]
  serverUrl?: string
  error?: string
}

interface ToggleResponse {
  ok: boolean
  error?: string | null
}

// ── Domain config (complete class strings, not templates) ─────────────────────

const DOMAIN_CFG: Record<string, { label: string; dot: string; iconBg: string; icon: string; iconOn: string; cardBg: string; cardBorder: string }> = {
  light:         { label: 'Light',   dot: 'bg-amber-400',   iconBg: 'bg-amber-400/20',   icon: 'text-amber-300',   iconOn: 'text-amber-500',   cardBg: 'bg-amber-500/10',   cardBorder: 'border-amber-500/25' },
  switch:        { label: 'Switch',  dot: 'bg-blue-400',    iconBg: 'bg-blue-400/20',    icon: 'text-blue-300',    iconOn: 'text-blue-600',    cardBg: 'bg-blue-500/10',    cardBorder: 'border-blue-500/25' },
  fan:           { label: 'Fan',     dot: 'bg-cyan-400',    iconBg: 'bg-cyan-400/20',    icon: 'text-cyan-300',    iconOn: 'text-cyan-600',    cardBg: 'bg-cyan-500/10',    cardBorder: 'border-cyan-500/25' },
  lock:          { label: 'Lock',    dot: 'bg-orange-400',  iconBg: 'bg-orange-400/20',  icon: 'text-orange-300',  iconOn: 'text-orange-500',  cardBg: 'bg-orange-500/10',  cardBorder: 'border-orange-500/25' },
  cover:         { label: 'Cover',   dot: 'bg-sky-400',     iconBg: 'bg-sky-400/20',     icon: 'text-sky-300',     iconOn: 'text-sky-600',     cardBg: 'bg-sky-500/10',     cardBorder: 'border-sky-500/25' },
  climate:       { label: 'Climate', dot: 'bg-emerald-400', iconBg: 'bg-emerald-400/20', icon: 'text-emerald-300', iconOn: 'text-emerald-600', cardBg: 'bg-emerald-500/10', cardBorder: 'border-emerald-500/25' },
  input_boolean: { label: 'Toggle',  dot: 'bg-violet-400',  iconBg: 'bg-violet-400/20',  icon: 'text-violet-300',  iconOn: 'text-violet-600',  cardBg: 'bg-violet-500/10',  cardBorder: 'border-violet-500/25' },
  media_player:  { label: 'Media',   dot: 'bg-purple-400',  iconBg: 'bg-purple-400/20',  icon: 'text-purple-300',  iconOn: 'text-purple-600',  cardBg: 'bg-purple-500/10',  cardBorder: 'border-purple-500/25' },
}
const DOMAIN_CFG_DEFAULT = { label: 'Device', dot: 'bg-zinc-400', iconBg: 'bg-zinc-400/20', icon: 'text-zinc-300', iconOn: 'text-zinc-600', cardBg: 'bg-zinc-500/10', cardBorder: 'border-zinc-500/25' }

const ALL_TAB = '__all__'
const ACTIVE_TAB = '__active__'
const DOMAIN_ORDER = ['light', 'switch', 'fan', 'lock', 'cover', 'climate', 'input_boolean', 'media_player']

function domainPriority(d: string) { const i = DOMAIN_ORDER.indexOf(d); return i === -1 ? 99 : i }
function isEntityOn(e: HAEntity) { return new Set(['on', 'open', 'playing', 'unlocked', 'home', 'heat', 'cool', 'auto', 'fan_only']).has(e.state) }
function isUnavailable(e: HAEntity) { return e.state === 'unavailable' || e.state === 'unknown' }
function sortEntities(entities: HAEntity[]) {
  return [...entities].sort((a, b) => domainPriority(a.domain) - domainPriority(b.domain) || a.friendly_name.localeCompare(b.friendly_name))
}

// ── Area icon ─────────────────────────────────────────────────────────────────

function AreaIcon({ name, className }: { name: string; className?: string }) {
  const n = name.toLowerCase()
  let Icon = Home
  if (/bed|master|sleep/.test(n)) Icon = BedDouble
  else if (/bath|shower/.test(n)) Icon = Waves
  else if (/kitchen|cook/.test(n)) Icon = ChefHat
  else if (/living|lounge|family|den/.test(n)) Icon = Tv2
  else if (/office|study|work/.test(n)) Icon = Monitor
  else if (/garage/.test(n)) Icon = Car
  else if (/garden|outdoor|yard|patio|deck|porch/.test(n)) Icon = TreePine
  else if (/hall|entry|entrance|foyer|corridor/.test(n)) Icon = DoorOpen
  else if (/dining|eat/.test(n)) Icon = UtensilsCrossed
  return <Icon className={className} />
}

// ── Domain icon ───────────────────────────────────────────────────────────────

function DomainIcon({ domain, className, strokeWidth }: { domain: string; className?: string; strokeWidth?: number }) {
  const props = { className, strokeWidth }
  switch (domain) {
    case 'light':        return <Lightbulb {...props} />
    case 'climate':      return <Thermometer {...props} />
    case 'fan':          return <Wind {...props} />
    case 'lock':         return <Lock {...props} />
    case 'media_player': return <Volume2 {...props} />
    default:             return <Power {...props} />
  }
}

// ── Device card ───────────────────────────────────────────────────────────────

interface CardProps {
  entity: HAEntity
  onToggle: (e: HAEntity, v: boolean) => void
  errorId: string | null
}

function DeviceCard({ entity, onToggle, errorId }: CardProps) {
  const isOn = isEntityOn(entity)
  const unavail = isUnavailable(entity)
  const cfg = DOMAIN_CFG[entity.domain] ?? DOMAIN_CFG_DEFAULT

  return (
    <button
      disabled={unavail}
      onClick={() => { onToggle(entity, !isOn) }}
      className={cn(
        'relative flex aspect-square w-full flex-col justify-between rounded-2xl p-3.5 text-left transition-all duration-150 active:scale-[0.96]',
        isOn ? 'bg-white shadow-lg shadow-black/30' : 'bg-white/[0.08] hover:bg-white/[0.11]',
        unavail && 'cursor-not-allowed opacity-30',
      )}
    >
      <div className="flex items-start justify-between">
        <div className={cn('flex size-10 items-center justify-center rounded-xl', isOn ? cfg.iconBg : 'bg-white/8')}>
          <DomainIcon
            domain={entity.domain}
            className={cn('size-5', isOn ? cfg.iconOn : 'text-white/50')}
            strokeWidth={isOn ? 2.5 : 1.75}
          />
        </div>
        <div className={cn('size-2 rounded-full', cfg.dot)} />
      </div>

      <div className="min-w-0">
        <p className={cn('text-xs font-medium', isOn ? 'text-gray-400' : 'text-white/35')}>
          {cfg.label}
        </p>
        <p className={cn('mt-0.5 truncate text-base font-bold leading-tight', isOn ? 'text-gray-900' : 'text-white/85')}>
          {entity.friendly_name}
        </p>
      </div>

      {errorId === entity.entity_id && (
        <p className="absolute inset-x-2 bottom-1.5 text-center text-[8px] text-destructive/80">Failed</p>
      )}
    </button>
  )
}

// ── Device grid ───────────────────────────────────────────────────────────────

function DeviceGrid({ entities, onToggle, errorId }: { entities: HAEntity[]; onToggle: (e: HAEntity, v: boolean) => void; errorId: string | null }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
      {sortEntities(entities).map((e) => (
        <DeviceCard key={e.entity_id} entity={e} onToggle={onToggle} errorId={errorId} />
      ))}
    </div>
  )
}

// ── Grouped grid (by area) ────────────────────────────────────────────────────

function groupByArea(entities: HAEntity[]): { name: string; entities: HAEntity[] }[] {
  const map = new Map<string, HAEntity[]>()
  const unassigned: HAEntity[] = []
  for (const e of entities) {
    if (e.area) {
      if (!map.has(e.area)) map.set(e.area, [])
      map.get(e.area)!.push(e)
    } else {
      unassigned.push(e)
    }
  }
  const groups = [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ents]) => ({ name, entities: ents }))
  if (unassigned.length) groups.push({ name: 'Other', entities: unassigned })
  return groups
}

interface GroupedGridProps {
  entities: HAEntity[]
  onToggle: (e: HAEntity, v: boolean) => void
  errorId: string | null
  onAreaClick?: (area: string) => void
}

function GroupedGrid({ entities, onToggle, errorId, onAreaClick }: GroupedGridProps) {
  const groups = groupByArea(entities)
  return (
    <div className="space-y-5">
      {groups.map((g) => {
        const onCount = g.entities.filter(isEntityOn).length
        return (
          <div key={g.name}>
            <button
              className="mb-2.5 flex w-full items-center gap-2 px-0.5 transition-opacity hover:opacity-70"
              onClick={() => onAreaClick?.(g.name)}
            >
              <AreaIcon name={g.name} className="size-4 shrink-0 text-muted-foreground/60" />
              <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground/60">{g.name}</span>
              {onCount > 0 && (
                <span className="ml-auto shrink-0 text-sm font-semibold text-brand">{onCount} on</span>
              )}
            </button>
            <DeviceGrid entities={g.entities} onToggle={onToggle} errorId={errorId} />
          </div>
        )
      })}
    </div>
  )
}

// ── Area tab bar ──────────────────────────────────────────────────────────────

function AreaTabBar({ areaNames, selected, onSelect }: { areaNames: string[]; selected: string; onSelect: (v: string) => void }) {
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-0.5 px-4 shrink-0" style={{ scrollbarWidth: 'none' }}>
      {[ALL_TAB, ACTIVE_TAB, ...areaNames].map((tab) => {
        const label = tab === ALL_TAB ? 'All' : tab === ACTIVE_TAB ? 'Active' : tab
        const active = tab === selected
        return (
          <button
            key={tab}
            onClick={() => { onSelect(tab) }}
            className={cn(
              'shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition-all',
              active
                ? 'bg-brand text-white shadow-sm'
                : 'bg-white/10 text-muted-foreground hover:bg-white/15 hover:text-foreground',
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

// ── Not-configured card ────────────────────────────────────────────────────────

function NotConfiguredCard() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-20">
      <div className="flex max-w-sm flex-col items-center gap-5 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-white/10">
          <Home className="size-8 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-lg font-bold tracking-tight">Connect Home Assistant</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Configure your Home Assistant URL and token in Admin settings to control devices.
          </p>
        </div>
        <Button variant="outline" className="gap-2" onClick={() => { navigate('/admin/home-assistant') }}>
          Go to Admin Settings
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchEntities(): Promise<EntitiesResponse> {
  const r = await fetch('/api/home-assistant/entities', { credentials: 'include' })
  if (!r.ok) throw new Error('fetch failed')
  return (await r.json()) as EntitiesResponse
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function HomeAssistantPage() {
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [errorId, setErrorId] = useState<string | null>(null)
  const [filterQuery, setFilterQuery] = useState('')
  const [showUnavailable, setShowUnavailable] = useState(false)
  const [selectedTab, setSelectedTab] = useState(ALL_TAB)
  const queryClient = useQueryClient()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['home-assistant-entities'],
    queryFn: fetchEntities,
    refetchInterval: 30000,
  })

  const merged: HAEntity[] = (data?.entities ?? []).map((e) =>
    e.entity_id in overrides ? { ...e, state: overrides[e.entity_id]! } : e,
  )

  const unavailableCount = merged.filter(isUnavailable).length
  const afterUnavailable = showUnavailable ? merged : merged.filter((e) => !isUnavailable(e))
  const visible = filterQuery.trim()
    ? afterUnavailable.filter((e) => {
        const q = filterQuery.toLowerCase()
        return e.friendly_name.toLowerCase().includes(q) || (e.area ?? '').toLowerCase().includes(q)
      })
    : afterUnavailable

  const totalOn = afterUnavailable.filter(isEntityOn).length
  const areaNames = [...new Set(merged.filter((e) => e.area).map((e) => e.area!))].sort()

  useBreadcrumbSearch({
    query: filterQuery,
    setQuery: setFilterQuery,
    placeholder: 'Filter devices...',
    externalHref: data?.serverUrl,
    settingsHref: '/admin/features',
  })

  async function handleToggle(entity: HAEntity, newOn: boolean) {
    const newState = newOn ? 'on' : 'off'
    const prevState = entity.state
    setOverrides((prev) => ({ ...prev, [entity.entity_id]: newState }))
    setErrorId(null)
    try {
      const resp = await fetch('/api/home-assistant/entity', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: entity.entity_id, action: newOn ? 'turn_on' : 'turn_off' }),
      })
      const result = (await resp.json()) as ToggleResponse
      if (!result.ok) {
        setOverrides((prev) => ({ ...prev, [entity.entity_id]: prevState }))
        setErrorId(entity.entity_id)
      } else {
        await queryClient.refetchQueries({ queryKey: ['home-assistant-entities'] })
        setOverrides((prev) => { const next = { ...prev }; delete next[entity.entity_id]; return next })
      }
    } catch {
      setOverrides((prev) => ({ ...prev, [entity.entity_id]: prevState }))
      setErrorId(entity.entity_id)
    }
  }

  return (
    <PageShell gradient="linear-gradient(135deg,#0f0e17,#1a1625,#0f1923)" GhostIcon={Home}>
      {/* Header */}
      <div className="shrink-0 flex items-end justify-between px-5 pt-5 pb-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-white/30">Smart Home</p>
          <h1 className="text-2xl font-black tracking-tight leading-none text-foreground">Home Assistant</h1>
        </div>
        {merged.length > 0 && (
          <div className="text-right">
            <p className="text-3xl font-black leading-none text-brand">{totalOn}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">devices on</p>
          </div>
        )}
      </div>

      {/* Stats row */}
      {merged.length > 0 && (
        <div className="shrink-0 flex items-center gap-2 px-5 pb-3">
          <span className="text-[11px] text-muted-foreground/60">{areaNames.length} rooms · {merged.length} devices</span>
          {unavailableCount > 0 && (
            <button
              onClick={() => { setShowUnavailable((p) => !p) }}
              className={cn(
                'ml-auto rounded-full border px-2.5 py-0.5 text-[10px] font-medium transition-all',
                showUnavailable
                  ? 'border-white/20 bg-white/10 text-foreground/80'
                  : 'border-white/15 bg-white/5 text-muted-foreground/70 hover:bg-white/10 hover:text-foreground/80',
              )}
            >
              {showUnavailable ? 'Hide unavailable' : `${unavailableCount} unavailable`}
            </button>
          )}
        </div>
      )}

      {/* Area tabs */}
      {merged.length > 0 && (
        <AreaTabBar areaNames={areaNames} selected={selectedTab} onSelect={setSelectedTab} />
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pb-6 pt-3 sm:px-5">
        {isLoading && (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
          </div>
        )}

        {isError && (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
            <WifiOff className="size-4" />
            Could not load devices.
          </div>
        )}

        {!isLoading && !isError && data?.configured === false && <NotConfiguredCard />}

        {!isLoading && !isError && data?.configured === true && (
          <>
            {data.error && (
              <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {data.error}
              </div>
            )}

            {merged.length === 0 && (
              <p className="py-20 text-center text-sm text-muted-foreground">
                No devices found. Sync Home Assistant in Admin settings.
              </p>
            )}

            {/* Active tab */}
            {selectedTab === ACTIVE_TAB && (() => {
              const active = visible.filter(isEntityOn)
              return active.length === 0
                ? <p className="py-20 text-center text-sm text-muted-foreground">No devices are on right now.</p>
                : <GroupedGrid entities={active} onToggle={handleToggle} errorId={errorId} onAreaClick={setSelectedTab} />
            })()}

            {/* Specific area tab */}
            {selectedTab !== ALL_TAB && selectedTab !== ACTIVE_TAB && (() => {
              const areaEntities = visible.filter((e) => e.area === selectedTab)
              const onCount = areaEntities.filter(isEntityOn).length
              return (
                <>
                  <div className="mb-4 flex items-center gap-3 px-0.5">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10">
                      <AreaIcon name={selectedTab} className="size-5 text-foreground/70" />
                    </div>
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-bold leading-tight">{selectedTab}</h2>
                      <p className="text-[11px] text-muted-foreground">
                        {areaEntities.length} device{areaEntities.length !== 1 ? 's' : ''} · {onCount} on
                      </p>
                    </div>
                  </div>
                  {areaEntities.length === 0
                    ? <p className="py-10 text-center text-sm text-muted-foreground">No devices here.</p>
                    : <DeviceGrid entities={areaEntities} onToggle={handleToggle} errorId={errorId} />
                  }
                </>
              )
            })()}

            {/* All tab — grouped by area */}
            {selectedTab === ALL_TAB && visible.length > 0 && (
              <GroupedGrid entities={visible} onToggle={handleToggle} errorId={errorId} onAreaClick={setSelectedTab} />
            )}

            {selectedTab === ALL_TAB && merged.length > 0 && visible.length === 0 && (
              <p className="py-20 text-center text-sm text-muted-foreground">
                {filterQuery.trim() ? `No devices match "${filterQuery}".` : 'All devices are unavailable.'}
              </p>
            )}
          </>
        )}
      </div>
    </PageShell>
  )
}
