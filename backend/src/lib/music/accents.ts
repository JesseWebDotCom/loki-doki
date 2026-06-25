// Named accent palette for stations (mirrors the frontend ColorPicker slugs). Each slug maps to
// a {primary, accent} hex pair used for generated art and gradient fallbacks. When no slug is
// given we derive a stable one from the station name so every station gets a consistent colour.

export interface AccentPair { primary: string; accent: string }

export const STATION_ACCENTS: Record<string, AccentPair> = {
  violet: { primary: '#6d28d9', accent: '#a78bfa' },
  blue: { primary: '#1d4ed8', accent: '#60a5fa' },
  cyan: { primary: '#0e7490', accent: '#22d3ee' },
  emerald: { primary: '#047857', accent: '#34d399' },
  amber: { primary: '#b45309', accent: '#fbbf24' },
  rose: { primary: '#be123c', accent: '#fb7185' },
  fuchsia: { primary: '#a21caf', accent: '#e879f9' },
  slate: { primary: '#334155', accent: '#94a3b8' },
}

const SLUGS = Object.keys(STATION_ACCENTS)

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

/** Pick a stable accent slug from a seed string (e.g. station name). */
export function accentForSeed(seed: string): string {
  return SLUGS[hash(seed) % SLUGS.length]!
}

/** Resolve a slug (or seed-derived fallback) to its hex pair. */
export function resolveProjectAccent(slug?: string | null): AccentPair {
  const pair = slug ? STATION_ACCENTS[slug] : undefined
  return pair ?? { primary: '#6d28d9', accent: '#a78bfa' }
}
