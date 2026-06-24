// Shared inputs for the prefetch system: a single cached read of the user's preferences
// (pinned/recent apps + saved location) and a derived warm-context ({ online, location }).
// Used by both the idle warmer (useAppWarmer) and the nav hover-intent hook
// (useIntentPrefetch) so they share one preferences fetch and one source of truth.

import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { useConnectivity } from '@/hooks/useConnectivity'
import type { UserLocation } from '@/hooks/useUserLocation'
import type { WarmCtx } from './registry'

// Mirror of useNavPreferences' default pinned set, used when the user has no saved order.
export const DEFAULT_PINNED = ['chat', 'maps', 'weather', 'time', 'news', 'imaging', 'links', 'youtube', 'podcasts']

export interface WarmPrefs {
  pinned: string[]
  recent: string[]
  location: UserLocation | null
}

export function useWarmPrefs() {
  const { user } = useAuth()
  return useQuery<WarmPrefs>({
    queryKey: ['user-preferences', user?.id],
    enabled: !!user?.id,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await fetch(`/api/users/${user!.id}/preferences`, { credentials: 'include' })
      const data = (r.ok ? await r.json() : {}) as Record<string, unknown>
      const rawPinned = data['nav.pinned_apps']
      const pinned = Array.isArray(rawPinned) && rawPinned.length ? (rawPinned as string[]) : DEFAULT_PINNED
      const rawRecent = data['nav.recent_apps']
      const recent = Array.isArray(rawRecent) ? (rawRecent as string[]) : []
      const location = (data['user.location'] as UserLocation | undefined) ?? null
      return { pinned, recent, location }
    },
  })
}

/** Derived context passed to each prefetcher. */
export function useWarmCtx(): WarmCtx {
  const connectivity = useConnectivity()
  const { data: prefs } = useWarmPrefs()
  const online = connectivity?.appMode === 'standard' && (connectivity?.hasNetwork ?? false)
  return { online, location: prefs?.location ?? null }
}
