import { Sparkles, GraduationCap, Blocks, Leaf, Palette, Flame, type LucideIcon } from 'lucide-react'

/**
 * Companion Store categories. Mirrors the App Store's `appCategories.ts` pattern
 * (declarative catalog for visuals/nav), but the category ASSIGNMENT lives on each
 * character row (`character.category`) so admin-authored companions categorize too.
 *
 * The `mature` category is the grown-up tier — its members carry elevated content
 * dials, so the per-user content gate renders them locked until the ceiling allows.
 */
export interface CompanionCategory {
  key: string
  name: string
  blurb: string
  gradient: string
  color: string
  icon: LucideIcon
  /** Marks the 18+ tier for badge/affordance treatment. */
  mature?: boolean
}

export const COMPANION_CATEGORIES: CompanionCategory[] = [
  {
    key: 'everyday',
    name: 'Everyday & Assistants',
    blurb: 'Friendly all-rounders for daily chat, questions, and getting things done.',
    gradient: 'linear-gradient(135deg,#1a0533,#7c3aed)',
    color: '#7c3aed',
    icon: Sparkles,
  },
  {
    key: 'coaches',
    name: 'Coaches & Mentors',
    blurb: 'Guidance, motivation, and a push to follow through.',
    gradient: 'linear-gradient(135deg,#4a1a05,#d97706)',
    color: '#d97706',
    icon: GraduationCap,
  },
  {
    key: 'family',
    name: 'Family & Kids',
    blurb: 'Wholesome storytellers and study buddies for the whole household.',
    gradient: 'linear-gradient(135deg,#064e3b,#10b981)',
    color: '#10b981',
    icon: Blocks,
  },
  {
    key: 'wellness',
    name: 'Wellness',
    blurb: 'Calm, supportive listeners for quieter moments.',
    gradient: 'linear-gradient(135deg,#083344,#0891b2)',
    color: '#0891b2',
    icon: Leaf,
  },
  {
    key: 'creative',
    name: 'Creative',
    blurb: 'Brainstorm partners and muses to break the blank page.',
    gradient: 'linear-gradient(135deg,#4a044e,#db2777)',
    color: '#db2777',
    icon: Palette,
  },
  {
    key: 'mature',
    name: 'Mature (18+)',
    blurb: 'Grown-up companions. Locked unless your content settings allow them.',
    gradient: 'linear-gradient(135deg,#450a0a,#b91c1c)',
    color: '#b91c1c',
    icon: Flame,
    mature: true,
  },
]

export const COMPANION_CATEGORY_BY_KEY: Record<string, CompanionCategory> =
  Object.fromEntries(COMPANION_CATEGORIES.map((c) => [c.key, c]))

export function getCompanionCategory(key: string | null | undefined): CompanionCategory | undefined {
  return key ? COMPANION_CATEGORY_BY_KEY[key] : undefined
}
