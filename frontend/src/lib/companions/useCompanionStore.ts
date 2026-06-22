import { useMemo } from 'react'
import { useActiveCompanion, type CompanionRecord } from '@/hooks/useActiveCompanion'

/** Is this companion locked by the user's content ceiling? */
export function isLocked(c: CompanionRecord): boolean {
  return c.gate ? !c.gate.usable : false
}

/**
 * Store-flavored view over the shared companion cache: the same active/favorite
 * state from {@link useActiveCompanion}, plus derived lookups (by id, by category,
 * per-category counts) used across the Companion Store pages.
 */
export function useCompanionStore() {
  const base = useActiveCompanion()
  const { companions } = base

  return useMemo(() => ({
    ...base,
    getCompanion: (id: string) => companions.find((c) => c.id === id),
    byCategory: (key: string) => companions.filter((c) => c.category === key),
    favoriteCompanions: companions.filter((c) => base.favorites.includes(c.id)),
  }), [base, companions])
}

/** Count of companions per category key (for the category index cards). */
export function companionCategoryCounts(companions: CompanionRecord[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const c of companions) {
    if (c.category) counts[c.category] = (counts[c.category] ?? 0) + 1
  }
  return counts
}
