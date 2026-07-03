import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { useAuth } from '@/context/AuthContext'
import {
  Home,
  Lightbulb,
  Power,
  Volume2,
  ChevronRight,
  WifiOff,
  DoorOpen,
  type LucideIcon,
} from 'lucide-react'
import { AreaIcon } from '@/components/homeassistant/AreaIcon'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { DeviceDetailDialog, type HAEntity } from '@/components/homeassistant/DeviceDetailDialog'
import { DeviceCard, isEntityOn, isUnavailable, type CardAction } from '@/components/homeassistant/DeviceCard'
import { cn } from '@/lib/cn'

// ── Types ────────────────────────────────────────────────────────────────────

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

const ALL_TAB = '__all__'
const ACTIVE_TAB = '__active__'
const DOMAIN_ORDER = ['light', 'switch', 'fan', 'lock', 'cover', 'climate', 'input_boolean', 'media_player']

function domainPriority(d: string) { const i = DOMAIN_ORDER.indexOf(d); return i === -1 ? 99 : i }

function sortEntities(entities: HAEntity[]) {
  return [...entities].sort((a, b) => domainPriority(a.domain) - domainPriority(b.domain) || a.friendly_name.localeCompare(b.friendly_name))
}

// ── Stat chips (clickable "all off" counters, per home + per room) ────────────

type StatKind = 'lights' | 'devices' | 'media' | 'doors'

// "Devices" excludes lights - those have their own counter.
const ON_DEVICE_DOMAINS = new Set(['switch', 'fan'])
const OPEN_STATES = new Set(['open', 'opening', 'unlocked'])

function statGroups(entities: HAEntity[]): Record<StatKind, HAEntity[]> {
  return {
    lights: entities.filter((e) => e.domain === 'light' && e.state === 'on'),
    devices: entities.filter((e) => ON_DEVICE_DOMAINS.has(e.domain) && e.state === 'on'),
    media: entities.filter((e) => e.domain === 'media_player' && e.state === 'playing'),
    doors: entities.filter((e) => !!e.security && OPEN_STATES.has(e.state)),
  }
}

const STAT_CFG: Record<StatKind, { Icon: LucideIcon; label: (n: number) => string; title: string; on: string; off: string; roundOn: string }> = {
  // design-ok(raw-palette-semantic): light-domain amber, matches DeviceCard state colors
  lights:  { Icon: Lightbulb,  label: (n) => `${n} light${n !== 1 ? 's' : ''} on`,  title: 'Turn all these lights off',   on: 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25',   off: 'bg-muted text-muted-foreground/50', roundOn: 'bg-amber-400 text-amber-950 hover:bg-amber-300' },
  // design-ok(raw-palette-semantic): switch/device-domain blue, matches DeviceCard state colors
  devices: { Icon: Power,      label: (n) => `${n} device${n !== 1 ? 's' : ''} on`, title: 'Turn all these devices off',  on: 'bg-blue-500/15 text-blue-300 hover:bg-blue-500/25',      off: 'bg-muted text-muted-foreground/50', roundOn: 'bg-blue-400 text-blue-950 hover:bg-blue-300' },
  media:   { Icon: Volume2,    label: (n) => `${n} playing`,                        title: 'Pause everything playing',    on: 'bg-brand/15 text-brand hover:bg-brand/25',                off: 'bg-muted text-muted-foreground/50', roundOn: 'bg-brand text-brand-foreground hover:bg-brand-hover' },
  doors:   { Icon: DoorOpen,   label: (n) => `${n} open`,                           title: 'Close doors & lock locks',    on: 'bg-destructive/15 text-destructive hover:bg-destructive/25', off: 'bg-muted text-muted-foreground/50', roundOn: 'bg-destructive text-destructive-foreground hover:bg-destructive/90' },
}
const STAT_ORDER: StatKind[] = ['lights', 'devices', 'media', 'doors']

interface StatChipsProps {
  groups: Record<StatKind, HAEntity[]>
  scopeKey: string
  onOff: (scopeKey: string, kind: StatKind, group: HAEntity[]) => void
  busyKey: string | null
  /** Round = mushroom-style circular icon chips with a count badge (room cards). */
  round?: boolean
}

// Always renders all four counters - zero counts show dimmed so every room
// (dining room included) gets the same at-a-glance row as the whole home.
function StatChips({ groups, scopeKey, onOff, busyKey, round }: StatChipsProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STAT_ORDER.map((kind) => {
        const cfg = STAT_CFG[kind]
        const group = groups[kind]
        const n = group.length
        const busy = busyKey === `${scopeKey}:${kind}`
        const active = n > 0

        if (round) {
          return (
            <button
              key={kind}
              type="button"
              disabled={!active || busy}
              title={active ? cfg.title : undefined}
              onClick={(e) => { e.stopPropagation(); onOff(scopeKey, kind, group) }}
              className={cn(
                'relative flex size-8 shrink-0 items-center justify-center rounded-full transition-all',
                active ? cn(cfg.roundOn, 'shadow-sm active:scale-90') : 'bg-muted text-muted-foreground/30 cursor-default',
              )}
            >
              {busy ? <Spinner size="sm" className="text-current" /> : <cfg.Icon className="size-3.5" strokeWidth={active ? 2.5 : 1.75} />}
              {active && (
                <span className="absolute -right-1 -top-1 flex size-4 min-w-4 items-center justify-center rounded-full border border-border bg-background text-[9px] font-bold leading-none text-foreground tabular-nums">
                  {n}
                </span>
              )}
            </button>
          )
        }

        return (
          <button
            key={kind}
            type="button"
            disabled={!active || busy}
            title={active ? cfg.title : undefined}
            onClick={(e) => { e.stopPropagation(); onOff(scopeKey, kind, group) }}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all',
              active ? cn(cfg.on, 'active:scale-95') : cn(cfg.off, 'cursor-default'),
            )}
          >
            {busy ? <Spinner size="sm" className="text-current" /> : <cfg.Icon className="size-3.5" />}
            <span className="tabular-nums">{cfg.label(n)}</span>
          </button>
        )
      })}
    </div>
  )
}

// ── Room accents (mushroom-style tinted containers; complete class strings) ───

const ACCENT_STYLES = {
  // design-ok(raw-palette-semantic): room identity accents (mushroom-style area tints)
  green:  { card: 'bg-emerald-500/[0.07]', circle: 'bg-emerald-500/20', icon: 'text-emerald-300' },
  // design-ok(raw-palette-semantic): room identity accents (mushroom-style area tints)
  blue:   { card: 'bg-blue-500/[0.07]',    circle: 'bg-blue-500/20',    icon: 'text-blue-300' },
  // design-ok(raw-palette-semantic): room identity accents (mushroom-style area tints)
  orange: { card: 'bg-orange-500/[0.07]',  circle: 'bg-orange-500/20',  icon: 'text-orange-300' },
  brand:  { card: 'bg-brand/[0.07]',       circle: 'bg-brand/20',       icon: 'text-brand' },
  // design-ok(raw-palette-semantic): room identity accents (mushroom-style area tints)
  cyan:   { card: 'bg-cyan-500/[0.07]',    circle: 'bg-cyan-500/20',    icon: 'text-cyan-300' },
  // design-ok(raw-palette-semantic): room identity accents (mushroom-style area tints)
  rose:   { card: 'bg-rose-500/[0.07]',    circle: 'bg-rose-500/20',    icon: 'text-rose-300' },
  // design-ok(raw-palette-semantic): room identity accents (mushroom-style area tints)
  amber:  { card: 'bg-amber-500/[0.07]',   circle: 'bg-amber-500/20',   icon: 'text-amber-300' },
  // design-ok(raw-palette-semantic): room identity accents (mushroom-style area tints)
  teal:   { card: 'bg-teal-500/[0.07]',    circle: 'bg-teal-500/20',    icon: 'text-teal-300' },
  slate:  { card: 'bg-muted/40',           circle: 'bg-muted',          icon: 'text-muted-foreground' },
} as const

const ACCENT_FALLBACKS: (keyof typeof ACCENT_STYLES)[] = ['green', 'blue', 'orange', 'brand', 'cyan', 'rose', 'amber', 'teal']

function areaAccent(name: string): (typeof ACCENT_STYLES)[keyof typeof ACCENT_STYLES] {
  const n = name.toLowerCase()
  if (/living|lounge|family|den/.test(n)) return ACCENT_STYLES.green
  if (/office|study|work/.test(n)) return ACCENT_STYLES.blue
  if (/bed|master|sleep/.test(n)) return ACCENT_STYLES.orange
  if (/kitchen|cook/.test(n)) return ACCENT_STYLES.brand
  if (/bath|shower|laundry/.test(n)) return ACCENT_STYLES.cyan
  if (/dining|eat/.test(n)) return ACCENT_STYLES.rose
  if (/hall|entry|entrance|foyer|corridor/.test(n)) return ACCENT_STYLES.amber
  if (/garden|outdoor|yard|patio|deck|porch/.test(n)) return ACCENT_STYLES.teal
  if (/garage|basement|attic|utility|other/.test(n)) return ACCENT_STYLES.slate
  // Stable per-name fallback so unrecognized rooms still get a consistent hue.
  let h = 0
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0
  return ACCENT_STYLES[ACCENT_FALLBACKS[h % ACCENT_FALLBACKS.length]!]
}

// First thermostat reading in the room - the mushroom-style temp in the corner.
function roomClimate(entities: HAEntity[]): { temp: number | null; humidity: number | null } {
  for (const e of entities) {
    if (e.domain !== 'climate') continue
    const a = e.attributes ?? {}
    const t = a['current_temperature']
    const h = a['current_humidity']
    if (typeof t === 'number') return { temp: t, humidity: typeof h === 'number' ? h : null }
  }
  return { temp: null, humidity: null }
}

// ── Device grid (wide mushroom-style cards - see components/homeassistant) ────

interface GridProps {
  entities: HAEntity[]
  onToggle: (e: HAEntity, v: boolean) => void
  onOpen: (e: HAEntity) => void
  onAction: CardAction
  errorId: string | null
  favorites: Set<string>
}

function DeviceGrid({ entities, onToggle, onOpen, onAction, errorId, favorites }: GridProps) {
  return (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
      {sortEntities(entities).map((e) => (
        <DeviceCard key={e.entity_id} entity={e} onToggle={onToggle} onOpen={onOpen} onAction={onAction} errorId={errorId} favorite={favorites.has(e.entity_id)} />
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

interface GroupedGridProps extends GridProps {
  onAreaClick?: (area: string) => void
  onBulkOff: (scopeKey: string, kind: StatKind, group: HAEntity[]) => void
  bulkBusy: string | null
}

function GroupedGrid({ entities, onToggle, onOpen, onAction, errorId, favorites, onAreaClick, onBulkOff, bulkBusy }: GroupedGridProps) {
  const groups = groupByArea(entities)
  return (
    <div className="space-y-4">
      {groups.map((g) => {
        const acc = areaAccent(g.name)
        const { temp, humidity } = roomClimate(g.entities)
        return (
          <div key={g.name} className={cn('rounded-sheet p-3.5 sm:p-4', acc.card)}>
            <div className="mb-3.5 flex w-full flex-wrap items-center gap-x-3 gap-y-2">
              <button
                className="flex min-w-0 items-center gap-3 text-left transition-opacity hover:opacity-80"
                onClick={() => onAreaClick?.(g.name)}
              >
                <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-full', acc.circle)}>
                  <AreaIcon name={g.name} className={cn('size-5', acc.icon)} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-base font-semibold leading-tight">{g.name}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {g.entities.length} device{g.entities.length !== 1 ? 's' : ''}
                  </span>
                </span>
              </button>
              <div className="ml-auto flex flex-col items-end gap-1.5">
                {temp !== null && (
                  <span className="text-lg font-semibold leading-none">
                    {Math.round(temp)}°
                    {humidity !== null && <span className="ml-1 text-[11px] font-normal text-muted-foreground">{Math.round(humidity)}%</span>}
                  </span>
                )}
                <StatChips groups={statGroups(g.entities)} scopeKey={`area:${g.name}`} onOff={onBulkOff} busyKey={bulkBusy} round />
              </div>
            </div>
            <DeviceGrid entities={g.entities} onToggle={onToggle} onOpen={onOpen} onAction={onAction} errorId={errorId} favorites={favorites} />
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
                ? 'bg-brand text-brand-foreground shadow-sm'
                : 'bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground',
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
        <div className="flex size-16 items-center justify-center rounded-card bg-muted">
          <Home className="size-8 text-muted-foreground" />
        </div>
        <div>
          <h2 className="text-title">Connect Home Assistant</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Configure your Home Assistant URL and token in Admin settings to control devices.
          </p>
        </div>
        <Button variant="outline" className="gap-2" onClick={() => { navigate('/admin/integrations/home-assistant') }}>
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

// Optimistic state for simple state-changing actions; null = no optimistic update.
function optimisticState(action: string): string | null {
  switch (action) {
    case 'turn_on': return 'on'
    case 'turn_off': return 'off'
    case 'lock': return 'locked'
    case 'unlock': return 'unlocked'
    case 'open': return 'open'
    case 'close': return 'closed'
    default: return null
  }
}

export function HomeAssistantPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [errorId, setErrorId] = useState<string | null>(null)
  const [filterQuery, setFilterQuery] = useState('')
  const [showUnavailable, setShowUnavailable] = useState(false)
  const [selectedTab, setSelectedTab] = useState(ALL_TAB)
  const [sheetId, setSheetId] = useState<string | null>(null)
  const [favorites, setFavorites] = useState<string[]>([])
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['home-assistant-entities'],
    queryFn: fetchEntities,
    refetchInterval: 30000,
  })

  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((prefs: Record<string, unknown> | null) => {
        const fav = prefs?.['ha.favorites']
        if (Array.isArray(fav)) setFavorites(fav.filter((v): v is string => typeof v === 'string'))
      })
      .catch(() => {})
  }, [user?.id])

  function toggleFavorite(entity: HAEntity) {
    if (!user?.id) return
    const next = favorites.includes(entity.entity_id)
      ? favorites.filter((id) => id !== entity.entity_id)
      : [...favorites, entity.entity_id]
    setFavorites(next)
    fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'ha.favorites': next }),
    }).catch(() => {})
  }

  const merged: HAEntity[] = (data?.entities ?? []).map((e) =>
    e.entity_id in overrides ? { ...e, state: overrides[e.entity_id]! } : e,
  )

  // Live entity for the sheet - re-derived every refetch so state stays fresh.
  const sheetEntity = sheetId ? merged.find((e) => e.entity_id === sheetId) ?? null : null
  const favoriteSet = new Set(favorites)

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

  useAppHeader({
    query: filterQuery,
    setQuery: setFilterQuery,
    placeholder: 'Filter devices...',
    externalHref: data?.serverUrl,
    settingsHref: '/home-assistant/settings',
  })

  // Generic device action - optimistic for simple state changes, refetch-driven
  // for value actions (setpoints, volume, brightness) whose result HA reports back.
  async function callEntity(entity: HAEntity, action: string, value?: number | string) {
    const optimistic = optimisticState(action)
    const prevState = entity.state
    if (optimistic) setOverrides((prev) => ({ ...prev, [entity.entity_id]: optimistic }))
    setErrorId(null)
    try {
      const resp = await fetch('/api/home-assistant/entity', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: entity.entity_id, action, ...(value !== undefined ? { value } : {}) }),
      })
      const result = (await resp.json()) as ToggleResponse
      if (!result.ok) {
        if (optimistic) setOverrides((prev) => ({ ...prev, [entity.entity_id]: prevState }))
        setErrorId(entity.entity_id)
      } else {
        await queryClient.refetchQueries({ queryKey: ['home-assistant-entities'] })
        setOverrides((prev) => { const next = { ...prev }; delete next[entity.entity_id]; return next })
      }
    } catch {
      if (optimistic) setOverrides((prev) => ({ ...prev, [entity.entity_id]: prevState }))
      setErrorId(entity.entity_id)
    }
  }

  function handleToggle(entity: HAEntity, newOn: boolean) {
    void callEntity(entity, newOn ? 'turn_on' : 'turn_off')
  }

  function openSheet(entity: HAEntity) {
    setSheetId(entity.entity_id)
  }

  const cardAction: CardAction = (entity, action, value) => { void callEntity(entity, action, value) }

  // "All off" for a stat chip: one grouped bulk call per action (doors split into
  // lock + close). Optimistic state for the whole group, refetch reconciles.
  async function bulkOff(scopeKey: string, kind: StatKind, group: HAEntity[]) {
    if (group.length === 0 || bulkBusy) return
    setBulkBusy(`${scopeKey}:${kind}`)
    setErrorId(null)
    const targetState = (e: HAEntity) =>
      kind === 'media' ? 'paused' : e.domain === 'lock' ? 'locked' : e.domain === 'cover' ? 'closed' : 'off'
    setOverrides((prev) => {
      const next = { ...prev }
      for (const e of group) next[e.entity_id] = targetState(e)
      return next
    })
    const post = (entityIds: string[], action: string) =>
      fetch('/api/home-assistant/bulk', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_ids: entityIds, action }),
      })
    try {
      const reqs: Promise<Response>[] = []
      if (kind === 'doors') {
        const locks = group.filter((e) => e.domain === 'lock').map((e) => e.entity_id)
        const covers = group.filter((e) => e.domain === 'cover').map((e) => e.entity_id)
        if (locks.length) reqs.push(post(locks, 'lock'))
        if (covers.length) reqs.push(post(covers, 'close'))
      } else {
        reqs.push(post(group.map((e) => e.entity_id), kind === 'media' ? 'media_pause' : 'turn_off'))
      }
      await Promise.all(reqs)
      await queryClient.refetchQueries({ queryKey: ['home-assistant-entities'] })
    } catch { /* refetch/cleanup below reconciles */ }
    finally {
      setOverrides((prev) => {
        const next = { ...prev }
        for (const e of group) delete next[e.entity_id]
        return next
      })
      setBulkBusy(null)
    }
  }

  return (
    <PageShell>
      {/* Header */}
      <div className="shrink-0 px-5">
        <PageHeader
          subtitle="Control your smart home devices and automations."
          className="pt-5 pb-3"
          actions={merged.length > 0 ? (
            <div className="text-right">
              <p className="text-3xl font-semibold tabular-nums leading-none text-brand">{totalOn}</p>
              <p className="text-caption text-muted-foreground mt-0.5">devices on</p>
            </div>
          ) : undefined}
        />
      </div>

      {/* Stats row */}
      {merged.length > 0 && (
        <div className="shrink-0 flex items-center gap-2 px-5 pb-3">
          <span className="text-[11px] text-muted-foreground/60">{areaNames.length} rooms · {merged.length} devices</span>
          {unavailableCount > 0 && (
            <button
              onClick={() => { setShowUnavailable((p) => !p) }}
              className={cn(
                'ml-auto rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-all',
                showUnavailable
                  ? 'bg-accent text-foreground/80'
                  : 'bg-muted text-muted-foreground/70 hover:bg-accent hover:text-foreground/80',
              )}
            >
              {showUnavailable ? 'Hide unavailable' : `${unavailableCount} unavailable`}
            </button>
          )}
        </div>
      )}

      {/* Whole-home "all off" chips */}
      {merged.length > 0 && (
        <div className="shrink-0 px-5 pb-3">
          <StatChips groups={statGroups(afterUnavailable)} scopeKey="home" onOff={bulkOff} busyKey={bulkBusy} />
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
            <Spinner size="lg" />
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
              <div className="mb-4 rounded-control border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
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
                : <GroupedGrid entities={active} onToggle={handleToggle} onOpen={openSheet} onAction={cardAction} errorId={errorId} favorites={favoriteSet} onAreaClick={setSelectedTab} onBulkOff={bulkOff} bulkBusy={bulkBusy} />
            })()}

            {/* Specific area tab */}
            {selectedTab !== ALL_TAB && selectedTab !== ACTIVE_TAB && (() => {
              const areaEntities = visible.filter((e) => e.area === selectedTab)
              const onCount = areaEntities.filter(isEntityOn).length
              const acc = areaAccent(selectedTab)
              const { temp, humidity } = roomClimate(areaEntities)
              return (
                <>
                  <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 px-0.5">
                    <div className={cn('flex size-11 shrink-0 items-center justify-center rounded-full', acc.circle)}>
                      <AreaIcon name={selectedTab} className={cn('size-5', acc.icon)} />
                    </div>
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold leading-tight">{selectedTab}</h2>
                      <p className="text-[11px] text-muted-foreground">
                        {areaEntities.length} device{areaEntities.length !== 1 ? 's' : ''} · {onCount} on
                      </p>
                    </div>
                    <div className="ml-auto flex flex-col items-end gap-1.5">
                      {temp !== null && (
                        <span className="text-lg font-semibold leading-none">
                          {Math.round(temp)}°
                          {humidity !== null && <span className="ml-1 text-[11px] font-normal text-muted-foreground">{Math.round(humidity)}%</span>}
                        </span>
                      )}
                      <StatChips groups={statGroups(areaEntities)} scopeKey={`area:${selectedTab}`} onOff={bulkOff} busyKey={bulkBusy} round />
                    </div>
                  </div>
                  {areaEntities.length === 0
                    ? <p className="py-10 text-center text-sm text-muted-foreground">No devices here.</p>
                    : <DeviceGrid entities={areaEntities} onToggle={handleToggle} onOpen={openSheet} onAction={cardAction} errorId={errorId} favorites={favoriteSet} />
                  }
                </>
              )
            })()}

            {/* All tab - grouped by area */}
            {selectedTab === ALL_TAB && visible.length > 0 && (
              <GroupedGrid entities={visible} onToggle={handleToggle} onOpen={openSheet} onAction={cardAction} errorId={errorId} favorites={favoriteSet} onAreaClick={setSelectedTab} onBulkOff={bulkOff} bulkBusy={bulkBusy} />
            )}

            {selectedTab === ALL_TAB && merged.length > 0 && visible.length === 0 && (
              <p className="py-20 text-center text-sm text-muted-foreground">
                {filterQuery.trim() ? `No devices match "${filterQuery}".` : 'All devices are unavailable.'}
              </p>
            )}
          </>
        )}
      </div>

      <DeviceDetailDialog
        entity={sheetEntity}
        onOpenChange={(open) => { if (!open) setSheetId(null) }}
        onAction={(entity, action, value) => { void callEntity(entity, action, value) }}
        favorite={!!sheetEntity && favoriteSet.has(sheetEntity.entity_id)}
        onToggleFavorite={toggleFavorite}
      />
    </PageShell>
  )
}
