import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'
import { geocodeLocation, type UserLocation } from '@/hooks/useUserLocation'
import { useCurrentPlace } from '@/hooks/useCurrentPlace'

const PREF_KEY = 'weather.locations'

/** A Weather-app list entry: a saved place, or the device's live location. */
export interface WeatherAppLocation extends UserLocation {
  /** True for the device's current place while traveling - leads the list,
   *  cannot be removed, and renders with a location glyph. */
  isCurrent?: boolean
}

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
  /** Current device place (traveling) first, then primary, then saved (deduped). */
  locations: WeatherAppLocation[]
  addLocation: (query: string) => Promise<UserLocation>
  removeLocation: (loc: UserLocation) => Promise<void>
}

/** The Weather app's location list: where the device actually is right now
 *  (when away from home), the user's primary location, and any extra cities
 *  they follow. Extra cities live in the `weather.locations` preference and
 *  never affect the primary location other apps rely on. */
export function useWeatherLocations(): UseWeatherLocationsResult {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const prefsQuery = useUserPreferences()
  const { current } = useCurrentPlace()

  const primary = (prefsQuery.data?.['user.location'] as UserLocation | undefined) ?? null
  const saved = (prefsQuery.data?.[PREF_KEY] as UserLocation[] | undefined) ?? []
  // The device's live place leads the list while traveling, so opening Weather
  // away from home shows the sky overhead, not the home town's.
  const currentLoc: WeatherAppLocation | null = current
    ? {
        city: current.label, country: '', countryCode: '',
        lat: current.lat, lng: current.lng,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        displayName: current.label,
        isCurrent: true,
      }
    : null
  const savedList = primary ? [primary, ...saved.filter((l) => !sameWeatherLocation(l, primary))] : saved
  const locations: WeatherAppLocation[] = currentLoc
    ? [currentLoc, ...savedList.filter((l) => !sameWeatherLocation(l, currentLoc))]
    : savedList

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
