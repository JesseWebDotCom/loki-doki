// Accent → gradient mapping for station art, shared by StationCard, StationArt, and the
// station page. Each entry is a multi-layer CSS background: a soft radial highlight in the
// upper-left (gives depth without a separate DOM element) over a rich 3-stop linear gradient.

const hi = 'radial-gradient(circle at 28% 22%, rgba(255,255,255,0.18) 0%, transparent 52%)'

export const STATION_GRADIENT: Record<string, string> = {
  violet:  `${hi}, linear-gradient(145deg,#3b0764 0%,#7c3aed 50%,#a78bfa 100%)`,
  blue:    `${hi}, linear-gradient(145deg,#172554 0%,#2563eb 50%,#7dd3fc 100%)`,
  cyan:    `${hi}, linear-gradient(145deg,#083344 0%,#0891b2 50%,#67e8f9 100%)`,
  emerald: `${hi}, linear-gradient(145deg,#052e16 0%,#059669 50%,#6ee7b7 100%)`,
  amber:   `${hi}, linear-gradient(145deg,#451a03 0%,#d97706 50%,#fde68a 100%)`,
  rose:    `${hi}, linear-gradient(145deg,#4c0519 0%,#e11d48 50%,#fda4af 100%)`,
  fuchsia: `${hi}, linear-gradient(145deg,#4a044e 0%,#c026d3 50%,#f0abfc 100%)`,
  slate:   `${hi}, linear-gradient(145deg,#020617 0%,#334155 50%,#94a3b8 100%)`,
}

export function stationGradient(accent: string | null): string {
  return STATION_GRADIENT[accent ?? 'violet'] ?? STATION_GRADIENT.violet!
}
