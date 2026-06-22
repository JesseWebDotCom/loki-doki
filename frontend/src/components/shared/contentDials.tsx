import { cn } from '@/lib/cn'

// Shared content-policy dial UI + metadata. Used by user settings (capped by the
// admin ceiling), the admin instance-ceiling editor, and the character studio.

export type DialKey = 'profanity' | 'sexual' | 'violence' | 'substances'
export type Candor = 'gentle' | 'balanced' | 'blunt'
export type ContentDialValues = Record<DialKey, string>

export interface DialDef {
  key: DialKey
  label: string
  help: string
  levels: { value: string; label: string }[]
}

export const CONTENT_DIALS: DialDef[] = [
  { key: 'profanity', label: 'Profanity', help: 'Swearing and vulgar language',
    levels: [{ value: 'off', label: 'Clean' }, { value: 'mild', label: 'Mild' }, { value: 'full', label: 'Full' }] },
  { key: 'sexual', label: 'Sexual', help: 'Romantic and sexual content',
    levels: [{ value: 'off', label: 'None' }, { value: 'suggestive', label: 'Suggestive' }, { value: 'explicit', label: 'Explicit' }] },
  { key: 'violence', label: 'Violence', help: 'Violence and gore in fiction',
    levels: [{ value: 'off', label: 'None' }, { value: 'moderate', label: 'Moderate' }, { value: 'graphic', label: 'Graphic' }] },
  { key: 'substances', label: 'Substances & crime', help: 'Frank discussion of drugs and crime',
    levels: [{ value: 'off', label: 'None' }, { value: 'discuss', label: 'Discuss' }, { value: 'detailed', label: 'Detailed' }] },
]

export const CANDOR_DEF = {
  label: 'Candor', help: 'Tone and bluntness (delivery, not content)',
  levels: [{ value: 'gentle', label: 'Gentle' }, { value: 'balanced', label: 'Balanced' }, { value: 'blunt', label: 'Blunt' }] as { value: Candor; label: string }[],
}

export const DIAL_KEYS = CONTENT_DIALS.map((d) => d.key)
export const MIN_DIALS: ContentDialValues = { profanity: 'off', sexual: 'off', violence: 'off', substances: 'off' }
export const MAX_DIALS: ContentDialValues = { profanity: 'full', sexual: 'explicit', violence: 'graphic', substances: 'detailed' }

const LEVEL_ORDER: Record<DialKey, string[]> = Object.fromEntries(
  CONTENT_DIALS.map((d) => [d.key, d.levels.map((l) => l.value)]),
) as Record<DialKey, string[]>

export function levelIdx(key: DialKey, v: string): number {
  const i = LEVEL_ORDER[key].indexOf(v)
  return i < 0 ? 0 : i
}

export function dialLabel(key: DialKey, v: string): string {
  return CONTENT_DIALS.find((d) => d.key === key)?.levels.find((l) => l.value === v)?.label ?? v
}

// Human-readable reason a character is locked, e.g. "Sexual: Explicit, Profanity: Full".
export function formatGateReason(blockedBy: { dial: string; required: string }[]): string {
  return blockedBy.map((b) => {
    const def = CONTENT_DIALS.find((d) => d.key === b.dial)
    const label = def?.label ?? b.dial
    const lvl = def?.levels.find((l) => l.value === b.required)?.label ?? b.required
    return `${label}: ${lvl}`
  }).join(', ')
}

export function normalizeDials(raw: Partial<Record<DialKey, unknown>> | null | undefined, fallback = MIN_DIALS): ContentDialValues {
  const out = { ...fallback }
  if (raw && typeof raw === 'object') {
    for (const k of DIAL_KEYS) {
      const v = raw[k]
      if (typeof v === 'string' && LEVEL_ORDER[k].includes(v)) out[k] = v
    }
  }
  return out
}

export function dialsEqual(a: ContentDialValues, b: ContentDialValues): boolean {
  return DIAL_KEYS.every((k) => a[k] === b[k])
}

// ── Segmented control ───────────────────────────────────────────────────────────
export function Segmented({ value, options, onChange }: {
  value: string
  options: { value: string; label: string; disabled?: boolean }[]
  onChange: (v: string) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          onClick={() => { if (!o.disabled) onChange(o.value) }}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs transition-colors',
            value === o.value ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            o.disabled && 'cursor-not-allowed opacity-30',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Dial group ───────────────────────────────────────────────────────────────────
// `ceiling` (optional) disables levels above the cap — used in user settings so a user
// can't exceed the admin instance ceiling.
export function ContentDialGroup({ values, ceiling, includeCandor, candor, onDial, onCandor }: {
  values: ContentDialValues
  ceiling?: ContentDialValues | null
  includeCandor?: boolean
  candor?: Candor
  onDial: (key: DialKey, value: string) => void
  onCandor?: (value: Candor) => void
}) {
  return (
    <div className="space-y-3">
      {CONTENT_DIALS.map((d) => (
        <div key={d.key} className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">{d.label}</p>
            <p className="text-xs text-muted-foreground">{d.help}</p>
          </div>
          <Segmented
            value={values[d.key]}
            onChange={(v) => onDial(d.key, v)}
            options={d.levels.map((l) => ({
              ...l,
              disabled: ceiling ? levelIdx(d.key, l.value) > levelIdx(d.key, ceiling[d.key]) : false,
            }))}
          />
        </div>
      ))}
      {includeCandor && onCandor && (
        <div className="flex items-center justify-between gap-4 border-t border-border/30 pt-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">{CANDOR_DEF.label}</p>
            <p className="text-xs text-muted-foreground">{CANDOR_DEF.help}</p>
          </div>
          <Segmented value={candor ?? 'balanced'} onChange={(v) => onCandor(v as Candor)} options={CANDOR_DEF.levels} />
        </div>
      )}
    </div>
  )
}
