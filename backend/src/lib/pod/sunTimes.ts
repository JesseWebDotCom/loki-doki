// Sunrise/sunset for a lat/lng on a given date — the NOAA solar-position approximation
// (no external dependency; accurate to within a minute or two, plenty for dimming a
// screen at dusk). Used by nightMode.ts as the substitute for "auto-dim on darkness":
// the Tab5 camera is MIPI-CSI (ESPHome has no capture platform for it — can't be a light
// sensor) and the board has no ambient-light sensor, so time-of-day is the honest lever.

const rad = (deg: number) => (deg * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5
}

/** NOAA General Solar Calculations — returns sunrise/sunset as Date objects (UTC) for the
 *  given calendar day at (lat, lng). Returns null if the sun doesn't rise/set that day
 *  (polar day/night) — callers should treat that as "no transition today". */
export function sunTimes(lat: number, lng: number, date: Date): { sunrise: Date; sunset: Date } | null {
  const jd = julianDay(date)
  const n = jd - 2451545.0 + 0.0008
  const meanSolarTime = n - lng / 360
  const M = rad((357.5291 + 0.98560028 * meanSolarTime) % 360)
  const C = 1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)
  const lambda = rad((deg(M) + C + 180 + 102.9372) % 360)
  const Jtransit = 2451545.0 + meanSolarTime + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * lambda)
  const sinDelta = Math.sin(lambda) * Math.sin(rad(23.4397))
  const cosHourAngle = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * sinDelta) / (Math.cos(rad(lat)) * Math.cos(Math.asin(sinDelta)))
  if (cosHourAngle < -1 || cosHourAngle > 1) return null   // polar day/night
  const Homega = deg(Math.acos(cosHourAngle))
  const Jrise = Jtransit - Homega / 360
  const Jset = Jtransit + Homega / 360
  return { sunrise: new Date((Jrise - 2440587.5) * 86400000), sunset: new Date((Jset - 2440587.5) * 86400000) }
}

/** Is `at` (default now) between tonight's sunset and tomorrow's sunrise? */
export function isNightAt(lat: number, lng: number, at: Date = new Date()): boolean {
  const today = sunTimes(lat, lng, at)
  if (!today) return false
  if (at < today.sunrise) return true    // before sunrise this morning
  if (at >= today.sunset) return true    // after sunset tonight
  return false
}
