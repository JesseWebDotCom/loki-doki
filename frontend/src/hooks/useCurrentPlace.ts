import { useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { getClientCoords, prewarmClientCoords, subscribeClientCoords } from '@/lib/clientLocation'

// Where the device actually IS right now, for weather surfaces. The companion
// got travel awareness in the device-location work; this brings the same signal
// to the Weather app, the Home card, the HUD chip, and the TV screens: when the
// device's coordinates put it meaningfully away from the saved home location,
// weather leads with the current place instead of home-town conditions.
//
// null means "use the saved home location": the device is home, has no
// geolocation grant, or the place could not be resolved. Never prompts for
// permission (prewarm only fetches an existing grant); the first surface that
// DOES prompt is chat/Maps/Settings, same as before.

export interface CurrentPlace {
  label: string
  lat: number
  lng: number
}

// One resolve per rounded coordinate across all mounted surfaces. ~1km grid,
// matching the server's reverse-geocode cache.
let cache: { key: string; place: CurrentPlace | null } | null = null

export function useCurrentPlace(): { current: CurrentPlace | null } {
  const { user } = useAuth()
  const [current, setCurrent] = useState<CurrentPlace | null>(() => cache?.place ?? null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    prewarmClientCoords()
    return subscribeClientCoords(() => setTick((t) => t + 1))
  }, [])

  const { clientLat, clientLng } = getClientCoords()

  useEffect(() => {
    if (!user?.id || clientLat === null || clientLng === null) {
      setCurrent(null)
      return
    }
    const key = `${clientLat.toFixed(2)},${clientLng.toFixed(2)}`
    if (cache?.key === key) {
      setCurrent(cache.place)
      return
    }
    let cancelled = false
    const params = new URLSearchParams({ lat: String(clientLat), lng: String(clientLng) })
    fetch(`/api/users/${user.id}/current-location?${params}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { current: null }))
      .then((d: { current: CurrentPlace | null }) => {
        if (cancelled) return
        cache = { key, place: d.current }
        setCurrent(d.current)
      })
      .catch(() => { if (!cancelled) setCurrent(null) })
    return () => { cancelled = true }
  }, [user?.id, clientLat, clientLng, tick])

  return { current }
}
