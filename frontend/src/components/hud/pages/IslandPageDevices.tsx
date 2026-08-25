import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Lightbulb, Star } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { HAIcon } from '@/components/homeassistant/HAIcon'
import { isEntityOn, isUnavailable } from '@/components/homeassistant/DeviceCard'
import type { HAEntity } from '@/components/homeassistant/DeviceDetailDialog'
import { HA_FAVORITES_KEY, HA_RECENTS_KEY, idList, pushHaRecent, saveHaRecents } from '@/lib/haRecents'

// Home-automation controls tab for the dock: quiet, pull-based control (no
// notifications) over the household's favorite and recently used devices.
// Favorites are the ones starred in the Devices app (ha.favorites); recents
// are whatever was last controlled from here or the app (ha.recents). Tap a
// row to toggle it; anything richer (dimming, thermostats, unlocking) deep
// links into the Devices app in the main window.

interface EntitiesResponse {
  configured: boolean
  entities?: HAEntity[]
  error?: string
}

async function fetchEntities(): Promise<EntitiesResponse> {
  const r = await fetch('/api/home-assistant/entities', { credentials: 'include' })
  if (!r.ok) throw new Error('fetch failed')
  return (await r.json()) as EntitiesResponse
}

function openDevicesApp() {
  window.maipaiDesktop?.openMainWindow('/home-assistant')
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')
}

function num(e: HAEntity, key: string): number | null {
  const v = e.attributes?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// Compact secondary line: "Kitchen · On · 60%".
function rowState(e: HAEntity): string {
  const parts: string[] = []
  if (e.area) parts.push(e.area)
  if (e.domain === 'climate') {
    const cur = num(e, 'current_temperature')
    parts.push(cur !== null ? `${cap(e.state)} · ${Math.round(cur)}°` : cap(e.state))
  } else if ((e.domain === 'light' || e.domain === 'fan') && e.state === 'on') {
    const pct = num(e, e.domain === 'light' ? 'brightness_pct' : 'percentage')
    parts.push(pct !== null ? `On · ${pct}%` : 'On')
  } else {
    parts.push(cap(e.state))
  }
  return parts.join(' · ')
}

// What a tap does. Simple, reversible state changes happen inline; everything
// else (unlocking, garage doors, thermostats, idle media players) opens the
// Devices app so the rich controls and the unlock confirm flow apply.
function tapAction(e: HAEntity): { action: string; optimistic: string } | 'open' {
  switch (e.domain) {
    case 'light':
    case 'switch':
    case 'fan':
    case 'input_boolean':
      return isEntityOn(e) ? { action: 'turn_off', optimistic: 'off' } : { action: 'turn_on', optimistic: 'on' }
    case 'media_player':
      if (e.state === 'playing') return { action: 'media_pause', optimistic: 'paused' }
      if (e.state === 'paused') return { action: 'media_play', optimistic: 'playing' }
      return 'open'
    case 'lock':
      // Locking from the dock is safe; unlocking goes through the app's ConfirmDialog.
      return e.state === 'unlocked' ? { action: 'lock', optimistic: 'locked' } : 'open'
    case 'cover':
      if (e.security) return 'open'
      return e.state === 'open' || e.state === 'opening'
        ? { action: 'close', optimistic: 'closed' }
        : { action: 'open', optimistic: 'open' }
    default:
      return 'open'
  }
}

// On-state icon tints per domain, following DeviceCard's state colors.
// design-ok(raw-palette-semantic): HA domain-state semantic colors, matches DeviceCard canonical precedent
const DOMAIN_ON: Record<string, { circle: string; icon: string }> = {
  // design-ok(raw-palette-semantic): HA domain-state semantic colors, matches DeviceCard canonical precedent
  light: { circle: 'bg-amber-400/25', icon: 'text-amber-300' },
  // design-ok(raw-palette-semantic): HA domain-state semantic colors, matches DeviceCard canonical precedent
  fan: { circle: 'bg-cyan-400/25', icon: 'text-cyan-300' },
  // design-ok(banned-palette): HA domain-state semantic (media_player=purple), see DeviceCard canonical precedent
  media_player: { circle: 'bg-purple-400/25', icon: 'text-purple-300' },
  // design-ok(raw-palette-semantic): HA domain-state semantic colors, matches DeviceCard canonical precedent
  lock: { circle: 'bg-red-400/25', icon: 'text-red-300' },
  // design-ok(raw-palette-semantic): HA domain-state semantic colors, matches DeviceCard canonical precedent
  cover: { circle: 'bg-sky-400/25', icon: 'text-sky-300' },
  // design-ok(raw-palette-semantic): HA domain-state semantic colors, matches DeviceCard canonical precedent
  climate: { circle: 'bg-emerald-400/25', icon: 'text-emerald-300' },
  // design-ok(raw-palette-semantic): HA domain-state semantic colors, matches DeviceCard canonical precedent
  default: { circle: 'bg-blue-400/25', icon: 'text-blue-300' },
}

function DeviceRow({ entity, favorite, busy, error, onTap }: {
  entity: HAEntity
  favorite: boolean
  busy: boolean
  error: boolean
  onTap: (e: HAEntity) => void
}) {
  const unavail = isUnavailable(entity)
  const on = isEntityOn(entity)
  const look = DOMAIN_ON[entity.domain] ?? DOMAIN_ON['default']!
  return (
    <button
      type="button"
      disabled={unavail || busy}
      onClick={() => onTap(entity)}
      title={unavail ? 'Unavailable' : undefined}
      // design-ok(glass-on-plain-bg): device row inside the black island surface
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[10px] bg-white/[0.07] px-2.5 py-1.5 text-left transition-colors',
        unavail ? 'opacity-35' : 'hover:bg-white/[0.12] active:scale-[0.99]',
      )}
    >
      <span className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full transition-colors',
        // design-ok(glass-on-plain-bg): icon circle inside the black island surface
        on && !unavail ? look.circle : 'bg-white/10',
      )}>
        {busy
          ? <Spinner size="sm" className="text-white/70" />
          : <HAIcon entity={entity} className={cn('size-4', on && !unavail ? look.icon : 'text-white/45')} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-white/90">{entity.friendly_name}</span>
          {/* design-ok(raw-palette-semantic): favorite-star amber, matches DeviceCard */}
          {favorite && <Star className="size-3 shrink-0 fill-current text-amber-400/90" />}
        </span>
        <span className={cn('block truncate text-[11px]', error ? 'text-destructive' : 'text-white/45')}>
          {error ? 'Command failed' : rowState(entity)}
        </span>
      </span>
    </button>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <p className="px-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-white/40">{children}</p>
}

export function IslandPageDevices() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [favorites, setFavorites] = useState<string[]>([])
  const [recents, setRecents] = useState<string[]>([])
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorId, setErrorId] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['home-assistant-entities'],
    queryFn: fetchEntities,
    refetchInterval: 30000,
  })

  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((prefs: Record<string, unknown> | null) => {
        setFavorites(idList(prefs?.[HA_FAVORITES_KEY]))
        setRecents(idList(prefs?.[HA_RECENTS_KEY]))
      })
      .catch(() => {})
  }, [user?.id])

  const merged: HAEntity[] = (data?.entities ?? []).map((e) =>
    e.entity_id in overrides ? { ...e, state: overrides[e.entity_id]! } : e,
  )
  const byId = new Map(merged.map((e) => [e.entity_id, e]))

  function recordRecent(entityId: string) {
    setRecents((prev) => {
      const next = pushHaRecent(prev, entityId)
      if (user?.id) saveHaRecents(user.id, next)
      return next
    })
  }

  async function handleTap(entity: HAEntity) {
    const tap = tapAction(entity)
    if (tap === 'open') { openDevicesApp(); return }
    const prevState = entity.state
    setOverrides((prev) => ({ ...prev, [entity.entity_id]: tap.optimistic }))
    setBusyId(entity.entity_id)
    setErrorId(null)
    recordRecent(entity.entity_id)
    try {
      const r = await fetch('/api/home-assistant/entity', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: entity.entity_id, action: tap.action }),
      })
      const result = (await r.json()) as { ok: boolean }
      if (!result.ok) throw new Error('failed')
      await queryClient.refetchQueries({ queryKey: ['home-assistant-entities'] })
    } catch {
      setOverrides((prev) => ({ ...prev, [entity.entity_id]: prevState }))
      setErrorId(entity.entity_id)
    } finally {
      setOverrides((prev) => { const next = { ...prev }; delete next[entity.entity_id]; return next })
      setBusyId(null)
    }
  }

  if (isLoading) {
    return <div className="flex h-full items-center justify-center"><Spinner size="lg" className="text-white/60" /></div>
  }

  if (data && !data.configured) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-white/60">Home Assistant isn't connected yet.</p>
        <Button
          variant="ghost"
          onClick={openDevicesApp}
          // design-ok(glass-on-plain-bg): sits inside the black island surface
          className="h-8 gap-1.5 rounded-full bg-white/10 px-3 text-xs font-semibold text-white/80 hover:bg-white/15 hover:text-white"
        >
          Open Devices <ExternalLink className="size-3" />
        </Button>
      </div>
    )
  }

  const favoriteEntities = favorites.map((id) => byId.get(id)).filter((e): e is HAEntity => !!e)
  const recentEntities = recents
    .map((id) => byId.get(id))
    .filter((e): e is HAEntity => !!e && !favorites.includes(e.entity_id))
  const lightsOn = merged.filter((e) => e.domain === 'light' && e.state === 'on')
  const onCount = merged.filter((e) => !isUnavailable(e) && isEntityOn(e)).length
  const empty = favoriteEntities.length === 0 && recentEntities.length === 0
  // Keeps the tab useful before anything is starred: the devices that are on now.
  const activeEntities = empty ? merged.filter((e) => !isUnavailable(e) && isEntityOn(e)).slice(0, 6) : []

  async function allLightsOff() {
    if (lightsOn.length === 0 || busyId) return
    setBusyId('__lights__')
    try {
      await fetch('/api/home-assistant/bulk', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_ids: lightsOn.map((e) => e.entity_id), action: 'turn_off' }),
      })
      await queryClient.refetchQueries({ queryKey: ['home-assistant-entities'] })
    } catch { /* next refetch reconciles */ }
    finally { setBusyId(null) }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {/* Status row: at-a-glance count, lights-off quick action, jump to the app */}
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-[11px] tabular-nums text-white/50">{onCount} on</span>
        {lightsOn.length > 0 && (
          <button
            type="button"
            onClick={() => void allLightsOff()}
            disabled={busyId !== null}
            // design-ok(raw-palette-semantic): light-domain amber, matches DeviceCard state colors
            className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300 transition-all hover:bg-amber-500/25 active:scale-95"
          >
            {busyId === '__lights__' ? <Spinner size="sm" className="text-current" /> : <Lightbulb className="size-3" />}
            Lights off
          </button>
        )}
        <button
          type="button"
          onClick={openDevicesApp}
          aria-label="Open the Devices app"
          title="Open the Devices app"
          className="ml-auto flex items-center gap-1 text-[11px] text-white/40 hover:text-white"
        >
          All devices <ExternalLink className="size-3" />
        </button>
      </div>

      {favoriteEntities.length > 0 && (
        <>
          <SectionLabel>Favorites</SectionLabel>
          {favoriteEntities.map((e) => (
            <DeviceRow key={e.entity_id} entity={e} favorite busy={busyId === e.entity_id} error={errorId === e.entity_id} onTap={(x) => void handleTap(x)} />
          ))}
        </>
      )}

      {recentEntities.length > 0 && (
        <>
          <SectionLabel>Recent</SectionLabel>
          {recentEntities.map((e) => (
            <DeviceRow key={e.entity_id} entity={e} favorite={false} busy={busyId === e.entity_id} error={errorId === e.entity_id} onTap={(x) => void handleTap(x)} />
          ))}
        </>
      )}

      {empty && activeEntities.length > 0 && (
        <>
          <SectionLabel>On now</SectionLabel>
          {activeEntities.map((e) => (
            <DeviceRow key={e.entity_id} entity={e} favorite={false} busy={busyId === e.entity_id} error={errorId === e.entity_id} onTap={(x) => void handleTap(x)} />
          ))}
        </>
      )}

      {empty && activeEntities.length === 0 && (
        <p className="px-0.5 py-6 text-center text-sm text-white/40">
          Nothing here yet. Star devices in the Devices app to pin them, or control one and it shows up under Recent.
        </p>
      )}
    </div>
  )
}
