// Accent → gradient mapping for station art, shared by StationCard, StationArt, and the
// station page. Kept in a plain module (not a component) so components can all import it
// without circular dependencies.

export const STATION_GRADIENT: Record<string, string> = {
  violet: 'linear-gradient(135deg,#6d28d9,#a78bfa)', blue: 'linear-gradient(135deg,#1d4ed8,#60a5fa)',
  cyan: 'linear-gradient(135deg,#0e7490,#22d3ee)', emerald: 'linear-gradient(135deg,#047857,#34d399)',
  amber: 'linear-gradient(135deg,#b45309,#fbbf24)', rose: 'linear-gradient(135deg,#be123c,#fb7185)',
  fuchsia: 'linear-gradient(135deg,#a21caf,#e879f9)', slate: 'linear-gradient(135deg,#334155,#94a3b8)',
}

export function stationGradient(accent: string | null): string {
  return STATION_GRADIENT[accent ?? 'violet'] ?? STATION_GRADIENT.violet!
}
