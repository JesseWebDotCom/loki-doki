// Shared inputs for the prefetch system: a derived read of the user's preferences
// (pinned/recent apps + saved location) and a derived warm-context ({ online, location }).
// Used by both the idle warmer (useAppWarmer) and the nav hover-intent hook
// (useIntentPrefetch). Backed by the app-wide useUserPreferences query, so this adds
// no extra request on top of the one shared preferences fetch.

import { useConnectivity } from '@/hooks/useConnectivity'
import { useUserPreferences, type UserPreferences } from '@/hooks/useUserPreferences'
import type { UserLocation } from '@/hooks/useUserLocation'
import type { WarmCtx } from './registry'

// Mirror of useNavPreferences' default pinned set, used when the user has no saved order.
export const DEFAULT_PINNED = ['chat', 'maps', 'weather', 'time', 'news', 'imaging', 'links', 'youtube', 'podcasts']

export interface WarmPrefs {
  pinned: string[]
  recent: string[]
  location: UserLocation | null
}

// Module-level so React Query's `select` memoization sees a stable reference.
function selectWarmPrefs(data: UserPreferences): WarmPrefs {
  const rawPinned = data['nav.pinned_apps']
  const pinned = Array.isArray(rawPinned) && rawPinned.length ? (rawPinned as string[]) : DEFAULT_PINNED
  const rawRecent = data['nav.recent_apps']
  const recent = Array.isArray(rawRecent) ? (rawRecent as string[]) : []
  const location = (data['user.location'] as UserLocation | undefined) ?? null
  return { pinned, recent, location }
}

export function useWarmPrefs() {
  return useUserPreferences(selectWarmPrefs)
}

/** Derived context passed to each prefetcher. */
export function useWarmCtx(): WarmCtx {
  const connectivity = useConnectivity()
  const { data: prefs } = useWarmPrefs()
  const online = connectivity?.appMode === 'standard' && (connectivity?.hasNetwork ?? false)
  return { online, location: prefs?.location ?? null }
}
