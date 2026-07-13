import { useQuery, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

// Single source of truth for the current user's key/value preferences
// (`GET /api/users/:id/preferences`). Every reader (nav prefs, saved location,
// prefetch warm context, HA favorites, view/source-filter toggles, …) shares this
// one query so the endpoint is fetched once per session instead of once per
// consumer. Writers PATCH the endpoint themselves and then call
// patchUserPreferencesCache so all readers stay consistent without a refetch.

export type UserPreferences = Record<string, unknown>

export function userPreferencesKey(userId: string | undefined) {
  return ['user-preferences', userId] as const
}

// Per-user localStorage cache so readers (e.g. useViewPreference, useSourceFilter)
// can paint the last-known preferences on the very first render of a fresh page
// load instead of a hard-coded fallback, avoiding a "default layout, then real
// layout" flash while the network fetch is in flight. Scoped by userId (unlike the
// shared IDB query-cache persister, which deliberately excludes this data) so a
// profile switch can never surface another user's cached prefs.
const LOCAL_CACHE_PREFIX = 'ld-prefs:'

function readCachedPreferences(userId: string): UserPreferences | undefined {
  try {
    const raw = localStorage.getItem(LOCAL_CACHE_PREFIX + userId)
    return raw ? (JSON.parse(raw) as UserPreferences) : undefined
  } catch {
    return undefined
  }
}

function writeCachedPreferences(userId: string, prefs: UserPreferences): void {
  try {
    localStorage.setItem(LOCAL_CACHE_PREFIX + userId, JSON.stringify(prefs))
  } catch {
    // storage full/unavailable; the network fetch remains the source of truth
  }
}

/** Call on logout so the next profile's first paint can't show a prior user's cached prefs. */
export function clearCachedUserPreferences(): void {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i)
    if (k?.startsWith(LOCAL_CACHE_PREFIX)) localStorage.removeItem(k)
  }
}

export function useUserPreferences<T = UserPreferences>(
  select?: (prefs: UserPreferences) => T,
) {
  const { user } = useAuth()
  return useQuery({
    queryKey: userPreferencesKey(user?.id),
    enabled: !!user?.id,
    staleTime: 5 * 60_000,
    select,
    initialData: user?.id ? readCachedPreferences(user.id) : undefined,
    initialDataUpdatedAt: 0, // stale immediately, so a background refetch always confirms/updates it
    queryFn: async (): Promise<UserPreferences> => {
      const r = await fetch(`/api/users/${user!.id}/preferences`, { credentials: 'include' })
      const prefs = (r.ok ? await r.json() : {}) as UserPreferences
      writeCachedPreferences(user!.id, prefs)
      return prefs
    },
  })
}

/** Merge a written preferences patch into the shared cache (call after/alongside a PATCH). */
export function patchUserPreferencesCache(
  queryClient: QueryClient,
  userId: string,
  patch: UserPreferences,
): void {
  queryClient.setQueryData<UserPreferences>(userPreferencesKey(userId), (old) => {
    const next = { ...(old ?? {}), ...patch }
    writeCachedPreferences(userId, next)
    return next
  })
}
