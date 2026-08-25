// ── Device-location travel awareness ──────────────────────────────────────────
// Companion clients (web/PWA phone, the MaiPai Desktop shell — all the same frontend
// bundle) send real device coordinates when the surface has geolocation
// permission, and always send their IANA timezone. This resolves those signals
// against the saved HOME location (`user.location` pref) into a "they are
// currently in X" answer, so the companion stops assuming home-town weather at
// a user in Brazil without them having to type "I'm in Brazil". The stated-
// location regex in companionTurn still outranks this — an explicit statement
// beats any sensor.
//
// Resolution order: real coordinates (ground truth — decides both away AND
// at-home, so a misconfigured device timezone can't fake a trip) > timezone
// mismatch (coarse; city inferred from the tz name) > null (no signal → caller
// keeps the home behavior).

import { reverse as offlineReverse } from '@/lib/maps/geocoder'

export interface HomeLocation {
  displayName?: string
  lat?: number
  lng?: number
  timezone?: string
}

export interface CurrentLocation {
  /** Human place name for the prompt and location-aware tools ("São Paulo, Brazil"). */
  label: string
  lat: number | null
  lng: number | null
  source: 'coords' | 'timezone'
}

/** Beyond this distance from home, coordinates count as traveling; inside it
 *  they positively confirm the user IS home. Wide enough that a day around the
 *  tri-state area doesn't flip the companion into travel mode. */
const AWAY_KM = 75

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371
  const dLat = ((bLat - aLat) * Math.PI) / 180
  const dLng = ((bLng - aLng) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

// Place names don't move: positive lookups cache for the process lifetime on a
// ~1km grid. Failures retry after a cooldown so one offline moment doesn't
// stick a raw-coordinates label for the whole trip.
const revCache = new Map<string, { label: string | null; at: number }>()
const FAIL_RETRY_MS = 5 * 60 * 1000

function formatPlace(city: string, state: string, country: string, countryCode: string): string {
  // US gets "City, State" (matches user.location's convention); elsewhere "City, Country".
  if (countryCode === 'US' && state) return `${city}, ${state}`
  return country ? `${city}, ${country}` : city
}

async function reverseLabel(lat: number, lng: number): Promise<string | null> {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`
  const hit = revCache.get(key)
  if (hit && (hit.label !== null || Date.now() - hit.at < FAIL_RETRY_MS)) return hit.label

  // Nominatim at city zoom first — a remote user is online by definition (they
  // are reaching the home server over the internet). Same UA/limits as the
  // detect-location endpoint. zoom=10 returns city-level, not house-level.
  let label: string | null = null
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10`,
      { headers: { 'User-Agent': 'maipai-home-app/1.0', 'Accept-Language': 'en' }, signal: AbortSignal.timeout(2500) },
    )
    if (res.ok) {
      const geo = (await res.json()) as {
        address?: {
          city?: string; town?: string; village?: string; municipality?: string; county?: string
          state?: string; country?: string; country_code?: string
        }
      }
      const a = geo.address ?? {}
      const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county
      if (city) label = formatPlace(city, a.state ?? '', a.country ?? '', (a.country_code ?? '').toUpperCase())
    }
  } catch { /* timeout/offline — try the offline maps below */ }

  // Offline maps fallback (in-process; only answers where a region is installed).
  if (!label) {
    try {
      const r = offlineReverse(lat, lng, 30)
      if (r?.title) label = r.title
    } catch { /* no regions installed */ }
  }

  revCache.set(key, { label, at: Date.now() })
  return label
}

// "America/Sao_Paulo" → "Sao Paulo". Offset-style zones carry no place.
function cityFromTz(tz: string): string | null {
  if (!tz.includes('/') || tz.startsWith('Etc/')) return null
  const seg = tz.split('/').pop()
  return seg ? seg.replace(/_/g, ' ') : null
}

// Enrich the bare tz city with its country via Open-Meteo's geocoder (already
// used by the weather tool and manual location entry). Degrades to the bare
// city name offline.
const tzLabelCache = new Map<string, string>()

async function tzLabel(tz: string): Promise<string | null> {
  const city = cityFromTz(tz)
  if (!city) return null
  const hit = tzLabelCache.get(tz)
  if (hit) return hit
  let label = city
  try {
    const res = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`,
      { signal: AbortSignal.timeout(2000) },
    )
    if (res.ok) {
      const data = (await res.json()) as {
        results?: Array<{ name: string; country?: string; country_code?: string; admin1?: string }>
      }
      const r = data.results?.[0]
      if (r) label = formatPlace(r.name, r.admin1 ?? '', r.country ?? '', (r.country_code ?? '').toUpperCase())
    }
  } catch { /* keep the bare city name */ }
  tzLabelCache.set(tz, label)
  return label
}

export async function resolveCurrentLocation(opts: {
  clientLat: number | null
  clientLng: number | null
  clientTz: string | null
  home: HomeLocation | undefined
}): Promise<CurrentLocation | null> {
  const { clientLat, clientLng, clientTz, home } = opts
  const hasCoords = typeof clientLat === 'number' && typeof clientLng === 'number'

  if (hasCoords && typeof home?.lat === 'number' && typeof home?.lng === 'number') {
    if (haversineKm(clientLat!, clientLng!, home.lat, home.lng) < AWAY_KM) return null
    const label = await reverseLabel(clientLat!, clientLng!)
    return {
      label: label ?? `coordinates ${clientLat!.toFixed(3)}, ${clientLng!.toFixed(3)}`,
      lat: clientLat!,
      lng: clientLng!,
      source: 'coords',
    }
  }

  // No coordinate comparison possible — fall back to the device timezone.
  // Same-timezone travel (Milford → Miami) is invisible here; coords catch it.
  if (!clientTz) return null
  const homeTz = home?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!homeTz || clientTz === homeTz) return null
  const label = await tzLabel(clientTz)
  if (!label) return null
  return {
    label,
    lat: hasCoords ? clientLat! : null,
    lng: hasCoords ? clientLng! : null,
    source: 'timezone',
  }
}
