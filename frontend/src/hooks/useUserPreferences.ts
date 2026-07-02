import { useQuery, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

// Single source of truth for the current user's key/value preferences
// (`GET /api/users/:id/preferences`). Every reader (nav prefs, saved location,
// prefetch warm context, HA favorites, …) shares this one query so the endpoint
// is fetched once per session instead of once per consumer. Writers PATCH the
// endpoint themselves and then call patchUserPreferencesCache so all readers
// stay consistent without a refetch.

export type UserPreferences = Record<string, unknown>

export function userPreferencesKey(userId: string | undefined) {
  return ['user-preferences', userId] as const
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
    queryFn: async (): Promise<UserPreferences> => {
      const r = await fetch(`/api/users/${user!.id}/preferences`, { credentials: 'include' })
      return (r.ok ? await r.json() : {}) as UserPreferences
    },
  })
}

/** Merge a written preferences patch into the shared cache (call after/alongside a PATCH). */
export function patchUserPreferencesCache(
  queryClient: QueryClient,
  userId: string,
  patch: UserPreferences,
): void {
  queryClient.setQueryData<UserPreferences>(userPreferencesKey(userId), (old) => ({
    ...(old ?? {}),
    ...patch,
  }))
}
