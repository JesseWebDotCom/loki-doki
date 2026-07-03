import { useEffect, useRef, useState } from 'react'
import {
  Lightbulb, Lock, LockOpen, Volume2, VolumeX,
  Play, Pause, SkipBack, SkipForward, Star, Minus, Plus, ShieldAlert,
} from 'lucide-react'
import { HAIcon } from './HAIcon'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/cn'

export interface HAEntity {
  entity_id: string
  state: string
  friendly_name: string
  domain: string
  device_class?: string | null
  area?: string
  security?: boolean
  attributes?: Record<string, unknown>
}

export type EntityAction = (entity: HAEntity, action: string, value?: number | string) => void

interface Props {
  entity: HAEntity | null
  onOpenChange: (open: boolean) => void
  onAction: EntityAction
  favorite: boolean
  onToggleFavorite: (entity: HAEntity) => void
}

const ON_STATES = new Set(['on', 'open', 'playing', 'unlocked'])

function num(attrs: Record<string, unknown> | undefined, key: string): number | null {
  const v = attrs?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function str(attrs: Record<string, unknown> | undefined, key: string): string | null {
  const v = attrs?.[key]
  return typeof v === 'string' && v ? v : null
}

// ── Per-domain bodies ─────────────────────────────────────────────────────────

function ClimateBody({ entity, onAction }: { entity: HAEntity; onAction: EntityAction }) {
  const attrs = entity.attributes
  const min = num(attrs, 'min_temp') ?? 45
  const max = num(attrs, 'max_temp') ?? 90
  const current = num(attrs, 'current_temperature')
  const hvacAction = str(attrs, 'hvac_action')
  const modes = Array.isArray(attrs?.['hvac_modes']) ? (attrs['hvac_modes'] as unknown[]).map(String) : []
  const [setpoint, setSetpoint] = useState<number | null>(num(attrs, 'temperature'))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  useEffect(() => { setSetpoint(num(entity.attributes, 'temperature')) }, [entity.entity_id, entity.attributes])

  function nudge(delta: number) {
    const base = setpoint ?? current ?? 70
    const next = Math.min(max, Math.max(min, Math.round(base + delta)))
    setSetpoint(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => onAction(entity, 'set_temperature', next), 400)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-center gap-6">
        {/* design-ok(hand-styled-button): circular thermostat nudge control */}
        <button type="button" onClick={() => nudge(-1)}
          className="flex size-12 items-center justify-center rounded-full bg-secondary text-foreground hover:bg-accent active:scale-95 transition-all">
          <Minus className="size-5" />
        </button>
        <div className="text-center">
          <p className="text-5xl font-semibold tabular-nums tracking-tight leading-none">{setpoint !== null ? `${setpoint}°` : '–'}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {current !== null ? `Currently ${Math.round(current)}°` : entity.state}
            {hvacAction && hvacAction !== 'idle' && hvacAction !== 'off' ? ` · ${hvacAction}` : ''}
          </p>
        </div>
        {/* design-ok(hand-styled-button): circular thermostat nudge control */}
        <button type="button" onClick={() => nudge(1)}
          className="flex size-12 items-center justify-center rounded-full bg-secondary text-foreground hover:bg-accent active:scale-95 transition-all">
          <Plus className="size-5" />
        </button>
      </div>
      {modes.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5">
          {modes.map(m => (
            <button key={m} type="button" onClick={() => onAction(entity, 'set_hvac_mode', m)}
              className={cn(
                'rounded-full px-3.5 py-1.5 text-xs font-semibold capitalize transition-all',
                // design-ok(raw-palette-semantic): climate-domain emerald, matches DeviceCard state colors
                entity.state === m ? 'bg-emerald-500 text-white' : 'bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground',
              )}>
              {m.replace('_', ' ')}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function MediaBody({ entity, onAction }: { entity: HAEntity; onAction: EntityAction }) {
  const attrs = entity.attributes
  const title = str(attrs, 'media_title')
  const artist = str(attrs, 'media_artist')
  const muted = attrs?.['is_volume_muted'] === true
  const playing = entity.state === 'playing'
  const [vol, setVol] = useState(() => Math.round((num(attrs, 'volume_level') ?? 0.5) * 100))
  useEffect(() => { setVol(Math.round((num(entity.attributes, 'volume_level') ?? 0.5) * 100)) }, [entity.entity_id, entity.attributes])

  return (
    <div className="space-y-5">
      <div className="text-center">
        <p className="truncate text-base font-bold">{title ?? (playing ? 'Playing' : entity.state.charAt(0).toUpperCase() + entity.state.slice(1))}</p>
        {artist && <p className="mt-0.5 truncate text-xs text-muted-foreground">{artist}</p>}
      </div>
      <div className="flex items-center justify-center gap-5">
        {/* design-ok(hand-styled-button): circular media transport control */}
        <button type="button" onClick={() => onAction(entity, 'media_previous')}
          className="flex size-11 items-center justify-center rounded-full bg-secondary hover:bg-accent active:scale-95 transition-all">
          <SkipBack className="size-4.5" />
        </button>
        {/* design-ok(hand-styled-button): circular media transport control */}
        <button type="button" onClick={() => onAction(entity, playing ? 'media_pause' : 'media_play')}
          className={cn(
            // design-ok(banned-palette): media-player domain purple, matches DeviceCard state colors
            'flex size-14 items-center justify-center rounded-full bg-purple-500 text-white hover:bg-purple-400 active:scale-95 transition-all',
          )}>
          {playing ? <Pause className="size-6" /> : <Play className="size-6 ml-0.5" />}
        </button>
        {/* design-ok(hand-styled-button): circular media transport control */}
        <button type="button" onClick={() => onAction(entity, 'media_next')}
          className="flex size-11 items-center justify-center rounded-full bg-secondary hover:bg-accent active:scale-95 transition-all">
          <SkipForward className="size-4.5" />
        </button>
      </div>
      <div className="flex items-center gap-3 px-1">
        <button type="button" onClick={() => onAction(entity, muted ? 'unmute' : 'mute')}
          className={cn('shrink-0 rounded-control p-1.5 transition-colors', muted ? 'text-destructive' : 'text-muted-foreground hover:text-foreground')}>
          {muted ? <VolumeX className="size-4.5" /> : <Volume2 className="size-4.5" />}
        </button>
        <input
          type="range" min={0} max={100} step={1} value={vol}
          onChange={e => setVol(Number(e.target.value))}
          onPointerUp={() => onAction(entity, 'set_volume', vol)}
          onKeyUp={() => onAction(entity, 'set_volume', vol)}
          className={cn(
            // design-ok(banned-palette): media-player domain purple, matches DeviceCard state colors
            'h-1.5 w-full cursor-pointer accent-purple-500',
          )}
        />
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{vol}%</span>
      </div>
    </div>
  )
}

function LightBody({ entity, onAction }: { entity: HAEntity; onAction: EntityAction }) {
  const isOn = entity.state === 'on'
  const [pct, setPct] = useState(() => num(entity.attributes, 'brightness_pct') ?? 100)
  useEffect(() => { setPct(num(entity.attributes, 'brightness_pct') ?? 100) }, [entity.entity_id, entity.attributes])

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between rounded-control bg-secondary/50 px-4 py-3">
        <span className="text-sm font-medium">{isOn ? 'On' : 'Off'}</span>
        <Switch checked={isOn} onCheckedChange={(v) => onAction(entity, v ? 'turn_on' : 'turn_off')} />
      </div>
      <div className="flex items-center gap-3 px-1">
        {/* design-ok(raw-palette-semantic): light-domain amber, matches DeviceCard state colors */}
        <Lightbulb className="size-4.5 shrink-0 text-amber-300" />
        <input
          type="range" min={1} max={100} step={1} value={pct}
          onChange={e => setPct(Number(e.target.value))}
          onPointerUp={() => onAction(entity, 'set_brightness', pct)}
          onKeyUp={() => onAction(entity, 'set_brightness', pct)}
          className={cn(
            // design-ok(raw-palette-semantic): light-domain amber, matches DeviceCard state colors
            'h-1.5 w-full cursor-pointer accent-amber-400',
          )}
        />
        <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
      </div>
    </div>
  )
}

function CoverBody({ entity, onAction }: { entity: HAEntity; onAction: EntityAction }) {
  const position = num(entity.attributes, 'current_position')
  const [pct, setPct] = useState(position ?? 50)
  useEffect(() => { const p = num(entity.attributes, 'current_position'); if (p !== null) setPct(p) }, [entity.entity_id, entity.attributes])

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5">
        <Button variant="outline" onClick={() => onAction(entity, 'open')}>Open</Button>
        <Button variant="outline" onClick={() => onAction(entity, 'close')}>Close</Button>
      </div>
      {position !== null && (
        <div className="flex items-center gap-3 px-1">
          <span className="shrink-0 text-xs text-muted-foreground">Position</span>
          <input
            type="range" min={0} max={100} step={1} value={pct}
            onChange={e => setPct(Number(e.target.value))}
            onPointerUp={() => onAction(entity, 'set_position', pct)}
            onKeyUp={() => onAction(entity, 'set_position', pct)}
            className={cn(
              // design-ok(raw-palette-semantic): cover-domain sky, matches DeviceCard state colors
              'h-1.5 w-full cursor-pointer accent-sky-400',
            )}
          />
          <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
        </div>
      )}
    </div>
  )
}

function LockBody({ entity, onAction }: { entity: HAEntity; onAction: EntityAction }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const locked = entity.state === 'locked'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        {locked ? <Lock className="size-4 text-success" /> : <LockOpen className="size-4 text-destructive" />}
        {locked ? 'Locked' : entity.state === 'unlocked' ? 'Unlocked' : entity.state}
      </div>
      {locked ? (
        <Button className="w-full" variant="destructive" onClick={() => setConfirmOpen(true)}>
          <LockOpen className="size-4 mr-1.5" />Unlock
        </Button>
      ) : (
        <Button className="w-full" onClick={() => onAction(entity, 'lock')}>
          <Lock className="size-4 mr-1.5" />Lock
        </Button>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Unlock ${entity.friendly_name}?`}
        description="This opens up your home, so make sure it's intentional."
        confirmLabel="Unlock"
        destructive
        onConfirm={() => onAction(entity, 'unlock')}
      />
    </div>
  )
}

function BinaryBody({ entity, onAction }: { entity: HAEntity; onAction: EntityAction }) {
  const isOn = ON_STATES.has(entity.state)
  return (
    <div className="flex items-center justify-between rounded-control bg-secondary/50 px-4 py-3">
      <span className="text-sm font-medium">{isOn ? 'On' : 'Off'}</span>
      <Switch checked={isOn} onCheckedChange={(v) => onAction(entity, v ? 'turn_on' : 'turn_off')} />
    </div>
  )
}

// ── Sheet ─────────────────────────────────────────────────────────────────────

export function DeviceDetailDialog({ entity, onOpenChange, onAction, favorite, onToggleFavorite }: Props) {
  return (
    <Dialog open={!!entity} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 border-border/60 p-5">
        {entity && (
          <>
            <DialogHeader className="mb-4 space-y-0">
              {/* pr-7 keeps the star clear of DialogContent's built-in close X */}
              <div className="flex items-center gap-3 pr-7">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-secondary">
                  <HAIcon entity={entity} className="size-5 text-foreground/80" />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <DialogTitle className="truncate text-base leading-tight">{entity.friendly_name}</DialogTitle>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {entity.area ?? 'No room'}
                    {entity.security && (
                      <span className="flex items-center gap-0.5 text-warning"><ShieldAlert className="size-3" />Security</span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onToggleFavorite(entity)}
                  className={cn('shrink-0 rounded-control p-2 transition-colors', favorite ? 'text-warning' : 'text-muted-foreground/40 hover:text-muted-foreground')}
                  aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
                >
                  <Star className={cn('size-5', favorite && 'fill-current')} />
                </button>
              </div>
            </DialogHeader>

            {entity.domain === 'climate' && <ClimateBody entity={entity} onAction={onAction} />}
            {entity.domain === 'media_player' && <MediaBody entity={entity} onAction={onAction} />}
            {entity.domain === 'light' && <LightBody entity={entity} onAction={onAction} />}
            {entity.domain === 'cover' && <CoverBody entity={entity} onAction={onAction} />}
            {entity.domain === 'lock' && <LockBody entity={entity} onAction={onAction} />}
            {['switch', 'fan', 'input_boolean'].includes(entity.domain) && <BinaryBody entity={entity} onAction={onAction} />}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
