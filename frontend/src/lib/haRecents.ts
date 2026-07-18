// Shared "recently controlled" tracking for Home Assistant devices. The list
// lives in user_preferences under ha.recents (most recent first, deduped,
// capped) so the dock's Devices tab and the Devices app record into one place.

export const HA_FAVORITES_KEY = 'ha.favorites'
export const HA_RECENTS_KEY = 'ha.recents'
export const HA_RECENTS_MAX = 8

/** Parse a preference value into a clean string list. */
export function idList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Prepend an entity id, dedupe, and cap the list. */
export function pushHaRecent(list: string[], entityId: string): string[] {
  return [entityId, ...list.filter((id) => id !== entityId)].slice(0, HA_RECENTS_MAX)
}

/** Fire-and-forget persist; callers keep their own optimistic state. */
export function saveHaRecents(userId: string, list: string[]): void {
  void fetch(`/api/users/${userId}/preferences`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [HA_RECENTS_KEY]: list }),
  }).catch(() => {})
}
