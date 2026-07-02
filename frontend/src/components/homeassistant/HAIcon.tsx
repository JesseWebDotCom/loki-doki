import { useEffect, useState, type CSSProperties } from 'react'
import {
  mdiAudioVideo, mdiBlinds, mdiBlindsOpen, mdiCast, mdiCastConnected, mdiCurtains, mdiCurtainsClosed,
  mdiDoorClosed, mdiDoorOpen, mdiFan, mdiFire, mdiGarage, mdiGarageOpen, mdiGate, mdiGateOpen,
  mdiLightbulbOn, mdiLightbulbOutline, mdiLock, mdiLockAlert, mdiLockOpenVariant, mdiPower,
  mdiPowerPlug, mdiPowerPlugOff, mdiRollerShade, mdiRollerShadeClosed, mdiSnowflake, mdiSpeaker,
  mdiTelevision, mdiThermostat, mdiToggleSwitch, mdiToggleSwitchOff, mdiWindowClosed, mdiWindowOpen,
  mdiWindowShutter, mdiWindowShutterOpen,
} from '@mdi/js'
import type { HAEntity } from './DeviceDetailDialog'

// Renders the SAME icon Home Assistant shows for an entity:
// 1. the entity's own `icon` attribute (integration- or user-set, "mdi:…"),
//    resolved against the full MDI set (lazy-loaded chunk, cached);
// 2. otherwise HA's default for the domain + device_class + state.

const OPEN = new Set(['open', 'opening'])

function defaultPath(e: HAEntity): string {
  const dc = e.device_class ?? null
  switch (e.domain) {
    case 'light':
      return e.state === 'on' ? mdiLightbulbOn : mdiLightbulbOutline
    case 'switch':
      if (dc === 'outlet') return e.state === 'on' ? mdiPowerPlug : mdiPowerPlugOff
      return e.state === 'on' ? mdiToggleSwitch : mdiToggleSwitchOff
    case 'input_boolean':
      return e.state === 'on' ? mdiToggleSwitch : mdiToggleSwitchOff
    case 'fan':
      return mdiFan
    case 'lock':
      if (e.state === 'jammed') return mdiLockAlert
      return e.state === 'locked' ? mdiLock : mdiLockOpenVariant
    case 'climate': {
      const act = e.attributes?.['hvac_action']
      if (act === 'heating') return mdiFire
      if (act === 'cooling') return mdiSnowflake
      return mdiThermostat
    }
    case 'media_player':
      if (dc === 'tv') return mdiTelevision
      if (dc === 'speaker') return mdiSpeaker
      if (dc === 'receiver') return mdiAudioVideo
      return e.state === 'playing' ? mdiCastConnected : mdiCast
    case 'cover': {
      const open = OPEN.has(e.state)
      switch (dc) {
        case 'garage':  return open ? mdiGarageOpen : mdiGarage
        case 'gate':    return open ? mdiGateOpen : mdiGate
        case 'door':    return open ? mdiDoorOpen : mdiDoorClosed
        case 'blind':   return open ? mdiBlindsOpen : mdiBlinds
        case 'shade':   return open ? mdiRollerShade : mdiRollerShadeClosed
        case 'curtain': return open ? mdiCurtains : mdiCurtainsClosed
        case 'window':  return open ? mdiWindowOpen : mdiWindowClosed
        default:        return open ? mdiWindowShutterOpen : mdiWindowShutter
      }
    }
    default:
      return mdiPower
  }
}

// Full MDI set, lazy-loaded once the first custom `mdi:` icon is encountered.
// ~10k icons — split into its own chunk so nobody pays for it until an entity
// actually declares a custom icon.
let mdiAll: Record<string, string> | null = null
let mdiLoading: Promise<void> | null = null
const listeners = new Set<() => void>()

function ensureMdiAll(): void {
  if (mdiAll || mdiLoading) return
  mdiLoading = import('@mdi/js').then((m) => {
    mdiAll = m as unknown as Record<string, string>
    for (const fn of listeners) fn()
    listeners.clear()
  }).catch(() => { mdiLoading = null })
}

// "mdi:garage-open" → "mdiGarageOpen"
function mdiExportName(icon: string): string | null {
  if (!icon.startsWith('mdi:')) return null
  const slug = icon.slice(4)
  if (!/^[a-z0-9-]+$/.test(slug)) return null
  return 'mdi' + slug.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
}

function customPath(icon: string | null): string | null {
  if (!icon) return null
  const name = mdiExportName(icon)
  if (!name) return null
  return mdiAll?.[name] ?? null
}

export function HAIcon({ entity, className, style }: { entity: HAEntity; className?: string; style?: CSSProperties }) {
  const icon = typeof entity.attributes?.['icon'] === 'string' ? (entity.attributes['icon'] as string) : null
  const [, bump] = useState(0)

  useEffect(() => {
    if (!icon || mdiAll) return
    const rerender = () => bump((v) => v + 1)
    listeners.add(rerender)
    ensureMdiAll()
    return () => { listeners.delete(rerender) }
  }, [icon])

  const d = customPath(icon) ?? defaultPath(entity)
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden focusable="false">
      <path fill="currentColor" d={d} />
    </svg>
  )
}

// Bare MDI path renderer for non-entity glyphs (HVAC-mode buttons etc.).
export function MdiGlyph({ path, className }: { path: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      <path fill="currentColor" d={path} />
    </svg>
  )
}
