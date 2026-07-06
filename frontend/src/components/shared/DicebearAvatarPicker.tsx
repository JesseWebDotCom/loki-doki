import { useState } from 'react'
import { Shuffle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import RiggedDicebearAvatar from '@/components/companion/RiggedDicebearAvatar'
import RoboEyesAvatar from '@/components/companion/RoboEyesAvatar'
import { coerceStyle, ROBO_EYES_STYLE } from '@/components/companion/styles'
import type { HeadTiltState } from '@/components/companion/useHeadTilt'
import { AVATAR_STYLES, fieldsForStyle, randomSeed, type RigField } from '@/components/companion/styleSchemas'
import { cn } from '@/lib/cn'

const POSES: { state: HeadTiltState; label: string }[] = [
  { state: 'idle',      label: '😐' },
  { state: 'listening', label: '😊' },
  { state: 'thinking',  label: '🤔' },
  { state: 'sad',       label: '😢' },
  { state: 'shocked',   label: '😲' },
  { state: 'angry',     label: '😠' },
]

// ── Color dot (for isColor fields) ───────────────────────────────────────────

function ColorDot({ active, hex, onClick }: { active: boolean; hex: string; onClick: () => void }) {
  const isTransparent = hex === 'transparent'
  return (
    <button
      type="button"
      onClick={onClick}
      title={isTransparent ? 'transparent' : `#${hex}`}
      className={cn(
        'size-5 rounded-full border shrink-0 transition-all',
        active
          ? 'ring-2 ring-brand ring-offset-1 ring-offset-background border-transparent scale-110'
          : 'border-border hover:scale-110',
      )}
      style={isTransparent
        ? { backgroundImage: 'linear-gradient(45deg,var(--border) 25%,transparent 25%,transparent 75%,var(--border) 75%),linear-gradient(45deg,var(--border) 25%,transparent 25%,transparent 75%,var(--border) 75%)', backgroundSize: '6px 6px', backgroundPosition: '0 0,3px 3px' }
        : { background: `#${hex}` }}
    />
  )
}

// ── Field row ─────────────────────────────────────────────────────────────────

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 min-h-[26px]">
      <span className="w-[68px] shrink-0 text-[10px] text-muted-foreground leading-tight">{label}</span>
      {children}
    </div>
  )
}

// ── Picker ────────────────────────────────────────────────────────────────────

interface DicebearAvatarPickerProps {
  style: string
  seed: string
  config: Record<string, unknown>
  onChange: (style: string, seed: string, config: Record<string, unknown>) => void
  /** Stack avatar above controls instead of side-by-side. Good for narrow columns. */
  vertical?: boolean
}

export function DicebearAvatarPicker({ style, seed, config, onChange, vertical }: DicebearAvatarPickerProps) {
  const [pose, setPose] = useState<HeadTiltState>((config._pose as HeadTiltState) ?? 'listening')

  function setStyle(next: string) { onChange(next, seed, config) }
  function shuffle() { onChange(style, randomSeed(), config) }

  function changePose(next: HeadTiltState) {
    setPose(next)
    onChange(style, seed, { ...config, _pose: next })
  }

  function setRig(field: RigField, value: string | null) {
    const cfg = { ...config }
    const probKey = `${field.key}Probability`
    if (value === null) {
      delete cfg[field.key]
      if (field.hasNone) cfg[probKey] = 0
    } else {
      cfg[field.key] = [value]
      if (field.hasNone) cfg[probKey] = 100
    }
    onChange(style, seed, cfg)
  }

  const fields = fieldsForStyle(style)
  const namedFields = fields.filter((f) => !f.isColor)
  const colorFields = fields.filter((f) => f.isColor)

  const avatarSize = vertical ? 96 : 88

  // Preview the chosen background color on the container itself (the rigged avatar
  // renders transparent so companions stay floating). A solid color reads as a
  // colored circle behind the head; transparent/unset falls back to the card surface.
  const bgColor = (config.backgroundColor as string[] | undefined)?.[0]
  const bgStyle = bgColor && bgColor !== 'transparent' ? { background: `#${bgColor}` } : undefined

  const preview = (
    <div className={cn('flex flex-col items-center gap-1.5', !vertical && 'shrink-0')}>
      <div
        className="overflow-hidden rounded-full border border-border bg-card"
        style={{ width: avatarSize, height: avatarSize, ...bgStyle }}
      >
        {style === ROBO_EYES_STYLE ? (
          <RoboEyesAvatar
            seed={seed || 'preview'}
            config={config}
            tiltState={pose}
            size={avatarSize}
          />
        ) : (
          <RiggedDicebearAvatar
            style={coerceStyle(style)}
            seed={seed || 'preview'}
            baseOptions={config}
            tiltState={pose}
            size={avatarSize}
          />
        )}
      </div>
      <div className="flex gap-0.5">
        {POSES.map((p) => (
          <button
            key={p.state}
            type="button"
            onClick={() => changePose(p.state)}
            title={p.state}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded text-xs transition-colors',
              pose === p.state ? 'bg-foreground/10' : 'opacity-40 hover:opacity-80',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={shuffle} className="gap-1.5">
        <Shuffle className="size-3.5" /> Shuffle
      </Button>
    </div>
  )

  const controls = (
    <div className="min-w-0 space-y-1.5">
      <FieldRow label="Style">
        <select value={style} onChange={(e) => setStyle(e.target.value)} className="ld-input h-7 py-0 text-xs">
          {AVATAR_STYLES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </FieldRow>

      {namedFields.map((field) => {
        const current = (config[field.key] as string[] | undefined)?.[0] ?? ''
        const isNone = field.hasNone && config[`${field.key}Probability`] === 0
        const value = isNone ? '' : current
        return (
          <FieldRow key={field.key} label={field.label}>
            <select
              value={value}
              onChange={(e) => setRig(field, e.target.value || null)}
              className="ld-input h-7 py-0 text-xs"
            >
              {field.hasNone && <option value="">–</option>}
              {!field.hasNone && !value && <option value="" disabled>Pick one</option>}
              {field.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label ?? o.value}</option>
              ))}
            </select>
          </FieldRow>
        )
      })}

      {colorFields.map((field) => {
        const current = (config[field.key] as string[] | undefined)?.[0] ?? null
        return (
          <FieldRow key={field.key} label={field.label}>
            <div className="flex flex-wrap gap-1.5">
              {field.options.map((o) => (
                <ColorDot key={o.value} active={current === o.value} hex={o.value} onClick={() => setRig(field, o.value)} />
              ))}
            </div>
          </FieldRow>
        )
      })}
    </div>
  )

  if (vertical) {
    return (
      <div className="space-y-3">
        {preview}
        {controls}
      </div>
    )
  }

  return (
    <div className="flex gap-3 items-start">
      {preview}
      <div className="flex-1 min-w-0 space-y-1.5">{controls}</div>
    </div>
  )
}
