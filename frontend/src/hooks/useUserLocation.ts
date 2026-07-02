import { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { useUserPreferences, patchUserPreferencesCache } from '@/hooks/useUserPreferences'

export interface UserLocation {
  city: string
  country: string
  countryCode: string
  lat: number
  lng: number
  timezone: string
  displayName: string
}

export type LocationStatus = 'loading' | 'ready' | 'detecting' | 'error'

export interface UseUserLocationResult {
  location: UserLocation | null
  status: LocationStatus
  error: string | null
  detect: () => Promise<void>
  setManual: (query: string) => Promise<void>
  clear: () => Promise<void>
}

export function useUserLocation(): UseUserLocationResult {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  // Location derives from the shared preferences query (one fetch app-wide)
  // instead of a per-mount fetch — this hook is mounted several times at once.
  const prefsQuery = useUserPreferences()
  // Local overlay for in-flight detect/search; 'loading'/'ready' come from the query.
  const [action, setAction] = useState<'idle' | 'detecting' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  const location = (prefsQuery.data?.['user.location'] as UserLocation | undefined) ?? null
  const status: LocationStatus =
    action === 'detecting' ? 'detecting'
    : action === 'error' ? 'error'
    : prefsQuery.data !== undefined || prefsQuery.isError ? 'ready'
    : 'loading'

  const setStatus = useCallback((s: 'detecting' | 'error' | 'ready') => {
    setAction(s === 'ready' ? 'idle' : s)
  }, [])

  const setLocation = useCallback((loc: UserLocation | null) => {
    if (!user?.id) return
    patchUserPreferencesCache(queryClient, user.id, { 'user.location': loc })
  }, [queryClient, user?.id])

  const save = useCallback(async (loc: UserLocation) => {
    if (!user?.id) return
    await fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'user.location': loc }),
    })
    setLocation(loc)
  }, [user?.id, setLocation])

  const detect = useCallback(async () => {
    if (!user?.id) return
    setStatus('detecting')
    setError(null)

    try {
      // Check if permission is already denied — if so, getCurrentPosition won't prompt,
      // it will silently fail. Surface a clear message instead.
      if (navigator.permissions) {
        const perm = await navigator.permissions.query({ name: 'geolocation' })
        if (perm.state === 'denied') {
          throw new Error('Location blocked — click the lock icon in your address bar and set Location to "Allow", then try again')
        }
      }

      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error('Geolocation is not supported by this browser'))
          return
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 30000,
          enableHighAccuracy: false,
          maximumAge: 60000,
        })
      })

      const { latitude: lat, longitude: lng } = pos.coords

      // Reverse geocode + timezone lookup done server-side (avoids CORS issues)
      const res = await fetch(`/api/users/${user.id}/detect-location`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? 'Location lookup failed')
      }

      const loc = await res.json() as UserLocation
      setLocation(loc)
      setStatus('ready')
    } catch (err) {
      const msg = err instanceof GeolocationPositionError
        ? err.code === 1 ? 'Location access denied — enable it in browser settings'
          : err.code === 2 ? 'Location unavailable'
          : 'Location timed out — on Mac, go to System Settings → Privacy & Security → Location Services and enable your browser, or type your city below'
        : err instanceof Error ? err.message
        : 'Location detection failed'
      setError(msg)
      setStatus('error')
    }
  }, [user?.id])

  const setManual = useCallback(async (query: string) => {
    setStatus('detecting')
    setError(null)

    try {
      const trimmed = query.trim()
      // Open-Meteo geocoding only understands city names, not postal codes.
      // Detect US zip codes (5-digit or ZIP+4) and use Nominatim instead.
      const isZip = /^\d{5}(-\d{4})?$/.test(trimmed)

      let lat: number, lng: number, city: string, country: string,
        countryCode: string, admin1: string | undefined, timezone: string

      if (isZip) {
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(trimmed)}&countrycodes=us&format=json&addressdetails=1&limit=1`,
          { headers: { 'User-Agent': 'loki-doki-app/1.0', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(8000) },
        )
        if (!geoRes.ok) throw new Error('Location search failed')
        const geoData = (await geoRes.json()) as Array<{
          lat: string; lon: string
          address?: { city?: string; town?: string; village?: string; county?: string; state?: string; country?: string; country_code?: string }
        }>
        const item = geoData[0]
        if (!item) throw new Error(`No location found for ZIP code "${trimmed}"`)
        const addr = item.address ?? {}
        lat = parseFloat(item.lat)
        lng = parseFloat(item.lon)
        city = addr.city ?? addr.town ?? addr.village ?? addr.county ?? trimmed
        country = addr.country ?? 'United States'
        countryCode = (addr.country_code ?? 'us').toUpperCase()
        admin1 = addr.state
        // Nominatim doesn't return timezone — get it from Open-Meteo using the coords
        const tzRes = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m&timezone=auto`,
          { signal: AbortSignal.timeout(5000) },
        )
        const tzData = tzRes.ok ? (await tzRes.json() as { timezone?: string }) : {}
        timezone = tzData.timezone ?? 'America/New_York'
      } else {
        const res = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(trimmed)}&count=1`,
          { signal: AbortSignal.timeout(8000) },
        )
        if (!res.ok) throw new Error('Location search failed')
        const data = (await res.json()) as {
          results?: Array<{ latitude: number; longitude: number; name: string; country: string; country_code: string; timezone: string; admin1?: string }>
        }
        const place = data.results?.[0]
        if (!place) throw new Error(`No location found for "${trimmed}"`)
        lat = place.latitude; lng = place.longitude
        city = place.name; country = place.country
        countryCode = place.country_code; admin1 = place.admin1; timezone = place.timezone
      }

      const loc: UserLocation = {
        city, country, countryCode, lat, lng, timezone,
        displayName: countryCode === 'US' && admin1 ? `${city}, ${admin1}` : `${city}, ${country}`,
      }

      await save(loc)
      setStatus('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Location search failed')
      setStatus('error')
    }
  }, [save])

  const clear = useCallback(async () => {
    if (!user?.id) return
    await fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'user.location': null }),
    })
    setLocation(null)
  }, [user?.id, setLocation])

  return { location, status, error, detect, setManual, clear }
}
