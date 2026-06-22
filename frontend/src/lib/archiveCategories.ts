import {
  BookMarked, GraduationCap, Wrench, Code2, BookOpen, HeartPulse,
  FlaskConical, Tent, Clapperboard, Baby, Map as MapIcon, Sparkles, Boxes,
  type LucideIcon,
} from 'lucide-react'

export interface CategoryVisual {
  icon: LucideIcon
  /** CSS gradient used as the card tile / icon background. */
  gradient: string
  /** Solid accent colour for chips, glows, and rings. */
  accent: string
}

// Order mirrors the backend ZIM_CATEGORIES so grouped sections read in a sensible
// sequence (Reference first, niche categories last).
export const CATEGORY_ORDER = [
  'Reference', 'Education', 'How-To', 'Development', 'Books', 'Medical',
  'Science', 'Survival', 'Entertainment', 'Kids', 'Maps', 'Religion',
] as const

const VISUALS: Record<string, CategoryVisual> = {
  Reference:     { icon: BookMarked,    accent: '#6366f1', gradient: 'linear-gradient(135deg,#4f46e5,#7c3aed)' },
  Education:     { icon: GraduationCap, accent: '#3b82f6', gradient: 'linear-gradient(135deg,#2563eb,#0ea5e9)' },
  'How-To':      { icon: Wrench,        accent: '#f59e0b', gradient: 'linear-gradient(135deg,#f59e0b,#ea580c)' },
  Development:   { icon: Code2,         accent: '#10b981', gradient: 'linear-gradient(135deg,#059669,#0d9488)' },
  Books:         { icon: BookOpen,      accent: '#f43f5e', gradient: 'linear-gradient(135deg,#e11d48,#f97316)' },
  Medical:       { icon: HeartPulse,    accent: '#ef4444', gradient: 'linear-gradient(135deg,#dc2626,#db2777)' },
  Science:       { icon: FlaskConical,  accent: '#8b5cf6', gradient: 'linear-gradient(135deg,#7c3aed,#2563eb)' },
  Survival:      { icon: Tent,          accent: '#65a30d', gradient: 'linear-gradient(135deg,#4d7c0f,#166534)' },
  Entertainment: { icon: Clapperboard,  accent: '#d946ef', gradient: 'linear-gradient(135deg,#c026d3,#db2777)' },
  Kids:          { icon: Baby,          accent: '#0ea5e9', gradient: 'linear-gradient(135deg,#0ea5e9,#facc15)' },
  Maps:          { icon: MapIcon,       accent: '#14b8a6', gradient: 'linear-gradient(135deg,#0d9488,#15803d)' },
  Religion:      { icon: Sparkles,      accent: '#a855f7', gradient: 'linear-gradient(135deg,#7e22ce,#4338ca)' },
}

const FALLBACK: CategoryVisual = { icon: Boxes, accent: '#64748b', gradient: 'linear-gradient(135deg,#475569,#334155)' }

export function categoryVisual(category: string): CategoryVisual {
  if (VISUALS[category]) return VISUALS[category];
  const lower = category.toLowerCase();
  const match = Object.keys(VISUALS).find(k => k.toLowerCase() === lower);
  return match ? VISUALS[match] : FALLBACK;
}

/** Sort comparator that honours CATEGORY_ORDER, pushing unknown categories last. */
export function compareCategories(a: string, b: string): number {
  const ia = CATEGORY_ORDER.indexOf(a as (typeof CATEGORY_ORDER)[number])
  const ib = CATEGORY_ORDER.indexOf(b as (typeof CATEGORY_ORDER)[number])
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
}

/** Human-readable file size, e.g. 8_000_000_000 → "8.0 GB". */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (!bytes || bytes <= 0) return null
  const gb = bytes / 1_000_000_000
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
  const mb = bytes / 1_000_000
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
}
