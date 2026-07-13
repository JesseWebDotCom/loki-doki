import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'
import { geocodeLocation, type UserLocation } from '@/hooks/useUserLocation'

const PREF_KEY = 'weather.locations'

/** Two saved places count as the same city when their names match or they sit
 *  within ~1km of each other (geocoders disagree on exact centroids). */
export function sameWeatherLocation(a: UserLocation, b: UserLocation): boolean {
  return a.displayName === b.displayName
    || (Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lng - b.lng) < 0.01)
}

export interface UseWeatherLocationsResult {
  /** The household-wide primary (`user.location`) - what widgets/briefing use. */
  primary: UserLocation | null
  /** Extra cities saved just for the Weather app (`weather.locations`). */
  saved: UserLocation[]
  /** Primary first, then saved (deduped). */
  locations: UserLocation[]
  addLocation: (query: string) => Promise<UserLocation>
  removeLocation: (loc: UserLocation) => Promise<void>
}

/** The Weather app's location list: the user's primary location plus any
 *  extra cities they follow. Extra cities live in the `weather.locations`
 *  preference and never affect the primary location other apps rely on. */
export function useWeatherLocations(): UseWeatherLocationsResult {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const prefsQuery = useUserPreferences()

  const primary = (prefsQuery.data?.['user.location'] as UserLocation | undefined) ?? null
  const saved = (prefsQuery.data?.[PREF_KEY] as UserLocation[] | undefined) ?? []
  const locations = primary ? [primary, ...saved.filter((l) => !sameWeatherLocation(l, primary))] : saved

  const persist = useCallback(async (next: UserLocation[]) => {
    if (!user?.id) return
    patchUserPreferencesCache(queryClient, user.id, { [PREF_KEY]: next })
    await fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [PREF_KEY]: next }),
    })
  }, [queryClient, user?.id])

  const addLocation = useCallback(async (query: string): Promise<UserLocation> => {
    const loc = await geocodeLocation(query)
    const existing = locations.find((l) => sameWeatherLocation(l, loc))
    if (existing) return existing
    await persist([...saved, loc])
    return loc
  }, [locations, saved, persist])

  const removeLocation = useCallback(async (loc: UserLocation) => {
    await persist(saved.filter((l) => !sameWeatherLocation(l, loc)))
  }, [saved, persist])

  return { primary, saved, locations, addLocation, removeLocation }
}
