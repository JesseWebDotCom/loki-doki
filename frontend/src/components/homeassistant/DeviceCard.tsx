import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown, ChevronUp, Lock, LockOpen, Minus, Pause, Play, Plus,
  MoreHorizontal, ShieldAlert, SkipBack, SkipForward, Square, Star,
} from 'lucide-react'
import { mdiAutorenew, mdiFan, mdiFire, mdiPower, mdiSnowflake, mdiWaterPercent } from './haDefaultIcons'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { HAIcon, MdiGlyph } from './HAIcon'
import { AreaIcon } from './AreaIcon'
import type { HAEntity } from './DeviceDetailDialog'

// Mushroom-style entity cards rendered with the SAME icons Home Assistant uses
// (entity `icon` attribute → MDI, else HA's domain/device_class defaults — see
// HAIcon). Header row = icon shape + name + live state; domains with real
// controls (climate, cover, lock, media, lit lights) get a full-width control
// strip underneath, like the Mushroom climate card. Motion makes running
// devices feel powered: breathing glow, fan spinning at its real speed, EQ bars
// + album art while playing, heating/cooling tints, a flowing energy line, and
// an alert ring on an unlocked door.

export function isEntityOn(e: HAEntity) {
  return new Set(['on', 'open', 'playing', 'unlocked', 'home', 'heat', 'cool', 'auto', 'fan_only']).has(e.state)
}
export function isUnavailable(e: HAEntity) {
  return e.state === 'unavailable' || e.state === 'unknown'
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')
}

function num(e: HAEntity, key: string): number | null {
  const v = e.attributes?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function str(e: HAEntity, key: string): string | null {
  const v = e.attributes?.[key]
  return typeof v === 'string' && v ? v : null
}

// Media artwork: HA-hosted pictures go through our authenticated HA proxy,
// external CDN artwork through the generic image proxy.
function artUrl(e: HAEntity): string | null {
  const p = str(e, 'entity_picture')
  if (!p) return null
  if (/^https?:\/\//i.test(p)) return proxyImg(p)
  if (p.startsWith('/')) return `/api/home-assistant/img?path=${encodeURIComponent(p)}`
  return null
}

// Live secondary line under the device name.
function stateLine(e: HAEntity): string {
  switch (e.domain) {
    case 'climate': {
      const cur = num(e, 'current_temperature')
      const act = str(e, 'hvac_action')
      const mode = cap(e.state)
      // Mushroom-style: "Heat · 68°" (+ what it's actively doing).
      const doing = act === 'heating' ? ' · heating' : act === 'cooling' ? ' · cooling' : ''
      return cur !== null ? `${mode} · ${Math.round(cur)}°${doing}` : mode
    }
    case 'media_player': {
      const title = str(e, 'media_title')
      if (e.state === 'playing') return title ? `${title}${str(e, 'media_artist') ? ` · ${str(e, 'media_artist')}` : ''}` : 'Playing'
      return cap(e.state)
    }
    case 'light': {
      const pct = num(e, 'brightness_pct')
      return e.state === 'on' ? (pct !== null ? `On · ${pct}%` : 'On') : cap(e.state)
    }
    case 'fan': {
      const pct = num(e, 'percentage')
      return e.state === 'on' ? (pct !== null ? `On · ${pct}%` : 'On') : cap(e.state)
    }
    case 'cover': {
      const pos = num(e, 'current_position')
      return pos !== null && pos > 0 && pos < 100 ? `${cap(e.state)} · ${pos}%` : cap(e.state)
    }
    default:
      return cap(e.state)
  }
}

// ── Per-domain visual identity (complete class strings) ──────────────────────

interface DomainLook {
  circleOn: string
  iconOn: string
  glow: string          // blurred halo behind the icon circle when active
  cardOn: string
  stateOn: string       // secondary-line tint when active
  line: string          // flowing energy-line gradient
}

function domainLook(e: HAEntity): DomainLook {
  const act = e.domain === 'climate' ? str(e, 'hvac_action') : null
  switch (e.domain) {
    case 'light':
      return { circleOn: 'bg-amber-400/25', iconOn: 'text-amber-300', glow: 'bg-amber-400/50', stateOn: 'text-amber-200/80',
        line: 'from-transparent via-amber-300/90 to-transparent',
        cardOn: 'bg-gradient-to-r from-amber-400/15 to-amber-400/[0.04] shadow-[0_0_28px_-8px_rgba(251,191,36,0.45)]' }
    case 'fan':
      return { circleOn: 'bg-cyan-400/25', iconOn: 'text-cyan-300', glow: 'bg-cyan-400/50', stateOn: 'text-cyan-200/80',
        line: 'from-transparent via-cyan-300/90 to-transparent',
        cardOn: 'bg-gradient-to-r from-cyan-400/15 to-cyan-400/[0.04] shadow-[0_0_28px_-8px_rgba(34,211,238,0.4)]' }
    case 'media_player':
      // design-ok(banned-palette): HA domain-state semantic (media_player=purple), see DeviceCard canonical precedent
      return { circleOn: 'bg-purple-400/25', iconOn: 'text-purple-300', glow: 'bg-purple-400/50', stateOn: 'text-purple-200/80',
        line: 'from-transparent via-purple-300/90 to-transparent',
        cardOn: 'bg-gradient-to-r from-purple-400/15 to-purple-400/[0.04] shadow-[0_0_28px_-8px_rgba(192,132,252,0.4)]' }
    case 'climate':
      if (act === 'heating')
        return { circleOn: 'bg-orange-400/25', iconOn: 'text-orange-300', glow: 'bg-orange-400/60', stateOn: 'text-orange-200/80',
          line: 'from-transparent via-orange-300/90 to-transparent',
          cardOn: 'bg-gradient-to-r from-orange-400/15 to-orange-400/[0.04] shadow-[0_0_28px_-8px_rgba(251,146,60,0.45)]' }
      if (act === 'cooling')
        return { circleOn: 'bg-sky-400/25', iconOn: 'text-sky-300', glow: 'bg-sky-400/60', stateOn: 'text-sky-200/80',
          line: 'from-transparent via-sky-300/90 to-transparent',
          cardOn: 'bg-gradient-to-r from-sky-400/15 to-sky-400/[0.04] shadow-[0_0_28px_-8px_rgba(56,189,248,0.45)]' }
      return { circleOn: 'bg-emerald-400/25', iconOn: 'text-emerald-300', glow: 'bg-emerald-400/40', stateOn: 'text-emerald-200/80',
        line: 'from-transparent via-emerald-300/80 to-transparent',
        cardOn: 'bg-gradient-to-r from-emerald-400/10 to-emerald-400/[0.03]' }
    case 'lock':
      return { circleOn: 'bg-red-400/25', iconOn: 'text-red-300', glow: 'bg-red-400/50', stateOn: 'text-red-200/80',
        line: 'from-transparent via-red-300/90 to-transparent',
        cardOn: 'bg-gradient-to-r from-red-400/15 to-red-400/[0.04] shadow-[0_0_28px_-8px_rgba(248,113,113,0.45)]' }
    case 'cover':
      return { circleOn: 'bg-sky-400/25', iconOn: 'text-sky-300', glow: 'bg-sky-400/45', stateOn: 'text-sky-200/80',
        line: 'from-transparent via-sky-300/80 to-transparent',
        cardOn: 'bg-gradient-to-r from-sky-400/12 to-sky-400/[0.03]' }
    default:
      return { circleOn: 'bg-blue-400/25', iconOn: 'text-blue-300', glow: 'bg-blue-400/45', stateOn: 'text-blue-200/80',
        line: 'from-transparent via-blue-300/90 to-transparent',
        cardOn: 'bg-gradient-to-r from-blue-400/15 to-blue-400/[0.04] shadow-[0_0_28px_-8px_rgba(96,165,250,0.4)]' }
  }
}

// ── Control strips (full-width second row, mushroom-style) ───────────────────

export type CardAction = (entity: HAEntity, action: string, value?: number | string) => void

const strip = 'flex flex-1 items-center justify-between rounded-full bg-white/[0.08] px-1.5 py-1'
const stripBtn = 'flex size-8 items-center justify-center rounded-full text-foreground/80 transition-all hover:bg-white/15 active:scale-90'
const roundBtn = 'flex size-10 shrink-0 items-center justify-center rounded-full bg-white/[0.08] transition-all hover:bg-white/15 active:scale-90'

function LightStrip({ entity, onAction }: { entity: HAEntity; onAction: CardAction }) {
  const [pct, setPct] = useState(() => num(entity, 'brightness_pct') ?? 100)
  useEffect(() => { const p = num(entity, 'brightness_pct'); if (p !== null) setPct(p) }, [entity.entity_id, entity.attributes])
  if (entity.state !== 'on') return null
  return (
    <div className="mt-2.5 flex items-center gap-2.5" onClick={(e) => e.stopPropagation()}>
      <input
        type="range" min={1} max={100} step={1} value={pct}
        onChange={(e) => setPct(Number(e.target.value))}
        onPointerUp={() => onAction(entity, 'set_brightness', pct)}
        onKeyUp={() => onAction(entity, 'set_brightness', pct)}
        className="ha-range w-full flex-1"
        style={{ background: `linear-gradient(to right, rgba(251,191,36,0.9) ${pct}%, rgba(255,255,255,0.14) ${pct}%)` }}
        aria-label="Brightness"
      />
      <span className="w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  )
}

// HVAC-mode cycle button icon + tint per mode.
const HVAC_MODE_META: Record<string, { path: string; cls: string }> = {
  heat:      { path: mdiFire,         cls: 'text-orange-300' },
  cool:      { path: mdiSnowflake,    cls: 'text-sky-300' },
  heat_cool: { path: mdiAutorenew,    cls: 'text-emerald-300' },
  auto:      { path: mdiAutorenew,    cls: 'text-emerald-300' },
  dry:       { path: mdiWaterPercent, cls: 'text-amber-200' },
  fan_only:  { path: mdiFan,          cls: 'text-cyan-300' },
  off:       { path: mdiPower,        cls: 'text-white/50' },
}

function ClimateStrip({ entity, onAction }: { entity: HAEntity; onAction: CardAction }) {
  const [setpoint, setSetpoint] = useState<number | null>(() => num(entity, 'temperature'))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { setSetpoint(num(entity, 'temperature')) }, [entity.entity_id, entity.attributes])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  function nudge(delta: number) {
    const min = num(entity, 'min_temp') ?? 45
    const max = num(entity, 'max_temp') ?? 90
    const next = Math.min(max, Math.max(min, Math.round((setpoint ?? num(entity, 'current_temperature') ?? 70) + delta)))
    setSetpoint(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => onAction(entity, 'set_temperature', next), 400)
  }

  const modes = Array.isArray(entity.attributes?.['hvac_modes'])
    ? (entity.attributes['hvac_modes'] as unknown[]).map(String).filter((m) => m in HVAC_MODE_META || m === 'off')
    : []
  const mode = HVAC_MODE_META[entity.state] ?? HVAC_MODE_META['off']!

  function cycleMode() {
    if (modes.length < 2) return
    const idx = modes.indexOf(entity.state)
    const next = modes[(idx + 1) % modes.length]!
    onAction(entity, 'set_hvac_mode', next)
  }

  return (
    <div className="mt-2.5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <div className={strip}>
        <button type="button" onClick={() => nudge(-1)} aria-label="Cooler" className={stripBtn}>
          <Minus className="size-4" />
        </button>
        <span className="text-base font-bold tabular-nums">{setpoint !== null ? setpoint : '—'}</span>
        <button type="button" onClick={() => nudge(1)} aria-label="Warmer" className={stripBtn}>
          <Plus className="size-4" />
        </button>
      </div>
      {modes.length > 0 && (
        <button type="button" onClick={cycleMode} title={`Mode: ${cap(entity.state)} — tap to switch`} className={roundBtn}>
          <MdiGlyph path={mode.path} className={cn('size-5', mode.cls)} />
        </button>
      )}
    </div>
  )
}

function MediaStrip({ entity, onAction }: { entity: HAEntity; onAction: CardAction }) {
  const playing = entity.state === 'playing'
  const [vol, setVol] = useState(() => Math.round((num(entity, 'volume_level') ?? 0.5) * 100))
  useEffect(() => { const v = num(entity, 'volume_level'); if (v !== null) setVol(Math.round(v * 100)) }, [entity.entity_id, entity.attributes])
  if (!playing && entity.state !== 'paused') return null
  return (
    <div className="mt-2.5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <div className={cn(strip, 'flex-none gap-0.5')}>
        <button type="button" onClick={() => onAction(entity, 'media_previous')} aria-label="Previous" className={stripBtn}>
          <SkipBack className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onAction(entity, playing ? 'media_pause' : 'media_play')}
          aria-label={playing ? 'Pause' : 'Play'}
          // design-ok(banned-palette): HA domain-state semantic (media_player=purple), see DeviceCard canonical precedent
          className={cn(stripBtn, playing && 'bg-purple-400/90 text-purple-950 hover:bg-purple-300')}
        >
          {playing ? <Pause className="size-4" /> : <Play className="ml-0.5 size-4" />}
        </button>
        <button type="button" onClick={() => onAction(entity, 'media_next')} aria-label="Next" className={stripBtn}>
          <SkipForward className="size-3.5" />
        </button>
      </div>
      <input
        type="range" min={0} max={100} step={1} value={vol}
        onChange={(e) => setVol(Number(e.target.value))}
        onPointerUp={() => onAction(entity, 'set_volume', vol)}
        onKeyUp={() => onAction(entity, 'set_volume', vol)}
        className="ha-range w-full flex-1"
        style={{ background: `linear-gradient(to right, rgba(192,132,252,0.9) ${vol}%, rgba(255,255,255,0.14) ${vol}%)` }}
        aria-label="Volume"
      />
    </div>
  )
}

function CoverStrip({ entity, onAction }: { entity: HAEntity; onAction: CardAction }) {
  const pos = num(entity, 'current_position')
  const moving = entity.state === 'opening' || entity.state === 'closing'
  return (
    <div className="mt-2.5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <div className={cn(strip, 'flex-none gap-0.5')}>
        <button type="button" onClick={() => onAction(entity, 'open')} aria-label="Open" className={stripBtn}>
          <ChevronUp className="size-4" />
        </button>
        <button type="button" onClick={() => onAction(entity, 'stop')} aria-label="Stop" className={cn(stripBtn, !moving && 'text-foreground/40')}>
          <Square className="size-3" />
        </button>
        <button type="button" onClick={() => onAction(entity, 'close')} aria-label="Close" className={stripBtn}>
          <ChevronDown className="size-4" />
        </button>
      </div>
      {/* design-ok(glass-on-plain-bg): HA mushroom-card glass system, matches surrounding white/[0.0x] card treatment */}
      <div className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-sky-400/80 transition-[width] duration-500"
          style={{ width: `${pos ?? (entity.state === 'open' || entity.state === 'opening' ? 100 : 0)}%` }}
        />
        {moving && <div className="ha-shimmer absolute inset-y-0 w-1/3 bg-white/40" />}
      </div>
      {pos !== null && <span className="w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums text-muted-foreground">{pos}%</span>}
    </div>
  )
}

function LockStrip({ entity, onAction }: { entity: HAEntity; onAction: CardAction }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const locked = entity.state === 'locked'
  return (
    <div className="mt-2.5 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => onAction(entity, 'lock')}
        disabled={locked}
        className={cn(
          'flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-xs font-semibold transition-all active:scale-[0.97]',
          locked ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/[0.08] text-foreground/80 hover:bg-white/15',
        )}
      >
        <Lock className="size-3.5" />Lock
      </button>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={!locked}
        className={cn(
          'flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-xs font-semibold transition-all active:scale-[0.97]',
          !locked ? 'bg-red-400/20 text-red-300' : 'bg-white/[0.08] text-foreground/80 hover:bg-white/15',
        )}
      >
        <LockOpen className="size-3.5" />Unlock
      </button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Unlock ${entity.friendly_name}?`}
        description="This opens up your home — make sure it's intentional."
        confirmLabel="Unlock"
        destructive
        onConfirm={() => onAction(entity, 'unlock')}
      />
    </div>
  )
}

// ── The card ──────────────────────────────────────────────────────────────────

const BINARY_DOMAINS = new Set(['light', 'switch', 'fan', 'input_boolean'])

export interface DeviceCardProps {
  entity: HAEntity
  onToggle: (e: HAEntity, v: boolean) => void
  onOpen: (e: HAEntity) => void
  onAction: CardAction
  errorId: string | null
  favorite: boolean
  /** Show the entity's area/room (the page groups by area, so it's off there). */
  showArea?: boolean
}

export function DeviceCard({ entity, onToggle, onOpen, onAction, errorId, favorite, showArea }: DeviceCardProps) {
  const isOn = isEntityOn(entity)
  const unavail = isUnavailable(entity)
  const look = domainLook(entity)
  const binary = BINARY_DOMAINS.has(entity.domain)
  const hvacAction = entity.domain === 'climate' ? str(entity, 'hvac_action') : null
  const climateRunning = hvacAction === 'heating' || hvacAction === 'cooling'
  const lockAlert = entity.domain === 'lock' && entity.state === 'unlocked'
  const playing = entity.domain === 'media_player' && entity.state === 'playing'
  const art = entity.domain === 'media_player' ? artUrl(entity) : null
  // Fan spins at (roughly) its real speed.
  const fanPct = entity.domain === 'fan' && isOn ? num(entity, 'percentage') ?? 60 : null
  // The icon "feels powered" when the device is genuinely doing something.
  const energized = !unavail && (
    (entity.domain === 'light' && isOn) || (entity.domain === 'fan' && isOn) ||
    playing || climateRunning || lockAlert ||
    ((entity.domain === 'switch' || entity.domain === 'input_boolean') && isOn)
  )
  const cardActive = !unavail && (isOn || climateRunning)

  return (
    <div
      role="button"
      tabIndex={unavail ? -1 : 0}
      onClick={() => { if (unavail) return; if (binary) onToggle(entity, !isOn); else onOpen(entity) }}
      onKeyDown={(e) => { if (unavail) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (binary) onToggle(entity, !isOn); else onOpen(entity) } }}
      className={cn(
        'group relative flex w-full cursor-pointer flex-col justify-center overflow-hidden rounded-card px-3 py-2.5 text-left transition-all duration-300 hover:-translate-y-px active:scale-[0.99]',
        showArea && 'pb-6',
        cardActive ? look.cardOn : 'bg-white/[0.06] hover:bg-white/[0.09]',
        unavail && 'cursor-not-allowed opacity-30',
      )}
    >
      {/* Header row: icon shape + name/state + quick toggle */}
      <div className="flex min-h-[50px] items-center gap-3">
        <div className="relative shrink-0">
          {energized && <div className={cn('ha-glow absolute inset-0 rounded-full blur-md', look.glow)} />}
          {lockAlert && <div className="ha-pulse-ring absolute inset-0 rounded-full border-2 border-red-400/70" />}
          {art ? (
            <img
              src={art}
              alt=""
              // design-ok(banned-palette): HA domain-state semantic (media_player=purple), see DeviceCard canonical precedent
              className={cn('relative size-12 rounded-full object-cover ring-2 transition-all duration-500', playing ? 'ring-purple-400/60' : 'ring-white/15 opacity-70')}
              draggable={false}
            />
          ) : (
            <div className={cn(
              'relative flex size-12 items-center justify-center rounded-full transition-all duration-300',
              energized || cardActive ? look.circleOn : 'bg-white/[0.07]',
            )}>
              <HAIcon
                entity={entity}
                className={cn(
                  'size-6 transition-colors duration-300',
                  energized || cardActive ? look.iconOn : 'text-white/40',
                  fanPct !== null && 'ha-spin-fan',
                )}
                style={fanPct !== null ? { animationDuration: `${(2.6 - (fanPct / 100) * 2).toFixed(2)}s` } : undefined}
              />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-[13px] font-semibold leading-tight text-foreground/90">
            <span className="truncate">{entity.friendly_name}</span>
            {favorite && <Star className="size-3 shrink-0 fill-current text-amber-400/90" />}
            {entity.security && <ShieldAlert className="size-3 shrink-0 text-amber-500/90" />}
          </p>
          <p className={cn('mt-0.5 truncate text-[11px] transition-colors duration-300', cardActive ? look.stateOn : 'text-muted-foreground')}>
            {stateLine(entity)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {playing && (
            <div className="flex h-4 items-end gap-[3px]" aria-hidden>
              {/* design-ok(banned-palette): HA domain-state semantic (media_player=purple), see DeviceCard canonical precedent */}
              {[0, 1, 2].map((i) => (
                <span key={i} className="ha-eq-bar w-[3px] rounded-full bg-purple-300" style={{ height: '100%', animationDelay: `${i * 0.18}s` }} />
              ))}
            </div>
          )}
          {binary && entity.domain !== 'light' && !unavail && (
            <span onClick={(e) => e.stopPropagation()}>
              <Switch checked={isOn} onCheckedChange={(v) => onToggle(entity, v)} aria-label={`Toggle ${entity.friendly_name}`} />
            </span>
          )}
          <button
            type="button"
            aria-label="Device details"
            onClick={(e) => { e.stopPropagation(); if (!unavail) onOpen(entity) }}
            className="-mr-1 rounded-full p-1 text-white/25 opacity-60 transition-all hover:text-white/60 group-hover:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </div>
      </div>

      {/* Full-width control strip (mushroom climate-card style) */}
      {!unavail && entity.domain === 'light' && <LightStrip entity={entity} onAction={onAction} />}
      {!unavail && entity.domain === 'climate' && <ClimateStrip entity={entity} onAction={onAction} />}
      {!unavail && entity.domain === 'media_player' && <MediaStrip entity={entity} onAction={onAction} />}
      {!unavail && entity.domain === 'cover' && <CoverStrip entity={entity} onAction={onAction} />}
      {!unavail && entity.domain === 'lock' && <LockStrip entity={entity} onAction={onAction} />}

      {/* Room label (same icon as the HA page's area headers), anchored bottom-right. */}
      {showArea && entity.area && (
        <span className="pointer-events-none absolute bottom-1.5 right-2.5 flex max-w-[60%] items-center gap-1 text-[10px] font-medium text-muted-foreground/55">
          <AreaIcon name={entity.area} className="size-3 shrink-0" />
          <span className="truncate">{entity.area}</span>
        </span>
      )}

      {/* Flowing energy line while the device is doing something */}
      {energized && (
        <div className={cn('ha-energy-line pointer-events-none absolute inset-x-4 bottom-0 h-[2px] rounded-full bg-gradient-to-r', look.line)} />
      )}

      {errorId === entity.entity_id && (
        <p className="absolute inset-x-2 bottom-0.5 text-center text-[8px] text-destructive/80">Failed</p>
      )}
    </div>
  )
}
