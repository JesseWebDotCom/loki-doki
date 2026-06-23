import { cn } from '@/lib/cn'

// Shared content-policy dial UI + metadata. Used by user settings (capped by the
// admin ceiling), the admin instance-ceiling editor, and the character studio.

// Mirror of backend lib/contentPolicy.ts CONTENT_CATEGORIES — keep in sync. Every
// axis tops out at `unrestricted`. Behavior is owned by the backend; this is UI only.
export type DialKey =
  | 'profanity' | 'sexual' | 'violence' | 'substances'
  | 'crime' | 'hate' | 'selfHarm' | 'privacy'
export type Candor = 'gentle' | 'balanced' | 'blunt'
export type ContentDialValues = Record<DialKey, string>

export interface DialDef {
  key: DialKey
  label: string
  help: string
  levels: { value: string; label: string }[]
}

const U = { value: 'unrestricted', label: 'Unrestricted' }

export const CONTENT_DIALS: DialDef[] = [
  { key: 'profanity', label: 'Profanity', help: 'Swearing and vulgar language',
    levels: [{ value: 'off', label: 'Clean' }, { value: 'mild', label: 'Mild' }, U] },
  { key: 'sexual', label: 'Sexual content', help: 'Romantic and sexual content',
    levels: [{ value: 'off', label: 'None' }, { value: 'suggestive', label: 'Suggestive' }, U] },
  { key: 'violence', label: 'Violence & gore', help: 'Violence and gore in fiction',
    levels: [{ value: 'off', label: 'None' }, { value: 'moderate', label: 'Moderate' }, U] },
  { key: 'substances', label: 'Drugs & alcohol', help: 'Discussion of drugs and intoxicants',
    levels: [{ value: 'off', label: 'None' }, { value: 'discuss', label: 'Discuss' }, U] },
  { key: 'crime', label: 'Crime & illicit how-to', help: 'Crime, fraud, hacking, weapons',
    levels: [{ value: 'off', label: 'None' }, { value: 'discuss', label: 'Discuss' }, U] },
  { key: 'hate', label: 'Hate & harassment', help: 'Slurs and demeaning content',
    levels: [{ value: 'off', label: 'None' }, { value: 'fiction', label: 'In fiction' }, U] },
  { key: 'selfHarm', label: 'Self-harm', help: 'Suicide and self-harm topics',
    levels: [{ value: 'off', label: 'Care' }, { value: 'discuss', label: 'Discuss' }, U] },
  { key: 'privacy', label: 'Privacy & people', help: 'Information about real people',
    levels: [{ value: 'off', label: 'Strict' }, { value: 'public', label: 'Public info' }, U] },
]

export const CANDOR_DEF = {
  label: 'Candor', help: 'Tone and bluntness (delivery, not content)',
  levels: [{ value: 'gentle', label: 'Gentle' }, { value: 'balanced', label: 'Balanced' }, { value: 'blunt', label: 'Blunt' }] as { value: Candor; label: string }[],
}

export const DIAL_KEYS = CONTENT_DIALS.map((d) => d.key)
export const MIN_DIALS: ContentDialValues = Object.fromEntries(DIAL_KEYS.map((k) => [k, 'off'])) as ContentDialValues
export const MAX_DIALS: ContentDialValues = Object.fromEntries(DIAL_KEYS.map((k) => [k, 'unrestricted'])) as ContentDialValues

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

// Legacy top values (pre-`unrestricted` rename) coerced on read.
const LEGACY_ALIAS: Record<string, string> = { full: 'unrestricted', explicit: 'unrestricted', graphic: 'unrestricted', detailed: 'unrestricted' }

export function normalizeDials(raw: Partial<Record<DialKey, unknown>> | null | undefined, fallback = MIN_DIALS): ContentDialValues {
  const out = { ...fallback }
  if (raw && typeof raw === 'object') {
    for (const k of DIAL_KEYS) {
      let v = raw[k]
      if (typeof v === 'string' && LEGACY_ALIAS[v] && LEVEL_ORDER[k].includes(LEGACY_ALIAS[v]!)) v = LEGACY_ALIAS[v]
      if (typeof v === 'string' && LEVEL_ORDER[k].includes(v)) out[k] = v
    }
  }
  return out
}

export function dialsEqual(a: ContentDialValues, b: ContentDialValues): boolean {
  return DIAL_KEYS.every((k) => a[k] === b[k])
}

// ── Segmented control ───────────────────────────────────────────────────────────
// Equal-width columns so multiple controls line up vertically. Pass a width via
// `className` (e.g. "w-[300px]"); without it the control fills its parent.
export function Segmented({ value, options, onChange, className }: {
  value: string
  options: { value: string; label: string; disabled?: boolean }[]
  onChange: (v: string) => void
  className?: string
}) {
  return (
    <div
      className={cn('grid gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5', className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          onClick={() => { if (!o.disabled) onChange(o.value) }}
          className={cn(
            'truncate rounded-md px-2 py-1 text-center text-xs transition-colors',
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
// can't exceed the admin instance ceiling. Rows are divided and the controls are a
// fixed width so every category lines up.
export function ContentDialGroup({ values, ceiling, includeCandor, candor, onDial, onCandor }: {
  values: ContentDialValues
  ceiling?: ContentDialValues | null
  includeCandor?: boolean
  candor?: Candor
  onDial: (key: DialKey, value: string) => void
  onCandor?: (value: Candor) => void
}) {
  return (
    <div className="divide-y divide-border/40">
      {CONTENT_DIALS.map((d) => (
        <div key={d.key} className="flex items-center justify-between gap-4 py-2.5 first:pt-0">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-tight">{d.label}</p>
            <p className="text-xs text-muted-foreground leading-tight mt-0.5">{d.help}</p>
          </div>
          <Segmented
            className="w-[300px] shrink-0"
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
        <div className="flex items-center justify-between gap-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-tight">{CANDOR_DEF.label}</p>
            <p className="text-xs text-muted-foreground leading-tight mt-0.5">{CANDOR_DEF.help}</p>
          </div>
          <Segmented className="w-[300px] shrink-0" value={candor ?? 'balanced'} onChange={(v) => onCandor(v as Candor)} options={CANDOR_DEF.levels} />
        </div>
      )}
    </div>
  )
}
