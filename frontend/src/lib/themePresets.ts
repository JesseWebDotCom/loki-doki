// User-selectable accent presets (#16). Each preset swaps only the hue of the brand accent,
// keeping the default lightness/chroma per mode so contrast stays consistent in light and
// dark. Applied at runtime by overriding the OKLCH token custom properties, so every control
// that reads --brand/--brand-hover/--ring retints with zero per-component changes. The brand
// GRADIENT (hero moments) is intentionally left untouched.

export interface AccentPreset {
  key: string
  label: string
  /** OKLCH hue angle. 288 = the app's default violet. */
  hue: number
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { key: 'default', label: 'Default', hue: 288 },
  { key: 'blue', label: 'Blue', hue: 262 },
  { key: 'cyan', label: 'Cyan', hue: 220 },
  { key: 'emerald', label: 'Emerald', hue: 162 },
  { key: 'amber', label: 'Amber', hue: 70 },
  { key: 'rose', label: 'Rose', hue: 12 },
]

// Lightness/chroma mirror index.css's --brand tokens per mode; only the hue varies.
const OVERRIDE_KEYS = ['--brand', '--brand-hover', '--ring'] as const

function varsFor(hue: number, mode: 'light' | 'dark'): Record<string, string> {
  return mode === 'dark'
    ? {
        '--brand': `oklch(0.72 0.16 ${hue})`,
        '--brand-hover': `oklch(0.76 0.15 ${hue})`,
        '--ring': `oklch(0.72 0.16 ${hue})`,
      }
    : {
        '--brand': `oklch(0.5 0.21 ${hue})`,
        '--brand-hover': `oklch(0.45 0.2 ${hue})`,
        '--ring': `oklch(0.5 0.21 ${hue})`,
      }
}

/** A CSS color usable in a swatch preview for the picker (mid lightness so it reads in both themes). */
export function accentSwatch(preset: AccentPreset): string {
  return `oklch(0.62 0.19 ${preset.hue})`
}

/** Apply (or clear, for 'default') the accent token overrides on <html>. */
export function applyAccent(key: string, mode: 'light' | 'dark'): void {
  const root = document.documentElement
  const preset = ACCENT_PRESETS.find(p => p.key === key)
  if (!preset || preset.key === 'default') {
    for (const k of OVERRIDE_KEYS) root.style.removeProperty(k)
    return
  }
  const vars = varsFor(preset.hue, mode)
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
}

export function isAccentKey(v: unknown): v is string {
  return typeof v === 'string' && ACCENT_PRESETS.some(p => p.key === v)
}
