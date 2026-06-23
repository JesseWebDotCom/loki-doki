// Shared US street-address parsing/normalisation. Used by both the property scraper
// (VGSI street index) and the people scraper (ThatsThem street matching), and reusable
// by anything that needs to split or canonicalise a street address.

/** Long-form → USPS-style suffix abbreviations, for canonical street comparison. */
const STREET_SUFFIX: Record<string, string> = {
  STREET: 'ST', AVENUE: 'AVE', BOULEVARD: 'BLVD', DRIVE: 'DR', COURT: 'CT',
  CIRCLE: 'CIR', PLACE: 'PL', ROAD: 'RD', LANE: 'LN', TERRACE: 'TER',
  HIGHWAY: 'HWY', PARKWAY: 'PKWY', TRAIL: 'TRL', CROSSING: 'XING', POINT: 'PT',
  GROVE: 'GRV',
}

export interface ParsedAddress {
  house: string
  street: string
  city: string
  state: string
  zip?: string
}

/**
 * Canonicalise a street for comparison: uppercase, collapse whitespace, and abbreviate the
 * trailing street suffix only. "Stiles Street" → "STILES ST", "Welchs Point Road" → "WELCHS
 * POINT RD". Only the LAST word is abbreviated — a name word that happens to match a suffix
 * (the "Point" in "Welchs Point Rd") must be left alone, or VGSI/ThatsThem won't match it.
 */
export function normalizeStreet(street: string): string {
  const words = street.trim().toUpperCase().replace(/\s+/g, ' ').split(' ')
  const last = words.length - 1
  return words.map((w, i) => (i === last ? STREET_SUFFIX[w] ?? w : w)).join(' ')
}

/**
 * Split a leading house number off a street string: "150 Stiles St" → { house, street }.
 * Handles ranges and unit letters ("150-152", "150A"). Returns null if there's no leading
 * number (i.e. not a street address we can look up).
 */
export function splitHouseStreet(input: string): { house: string; street: string } | null {
  const m = input.trim().match(/^(\d+(?:-\d+)?[A-Za-z]?)\s+(.+)$/)
  if (!m) return null
  return { house: m[1]!, street: m[2]!.trim() }
}

/**
 * Best-effort parse of a full US address into structured parts. Tries, in order:
 *  1. explicit parts already supplied by the caller (OSM tags etc.)
 *  2. "<street>, <city>, <ST> <zip?>"
 * Returns null if it can't recover house+street+city+state.
 */
export function parseUsAddress(
  raw: string,
  parts?: { house?: string; street?: string; city?: string; state?: string; zip?: string },
): ParsedAddress | null {
  // 1. Structured parts win when complete.
  if (parts?.street && parts.city && parts.state) {
    const houseStreet = parts.house ? `${parts.house} ${parts.street}` : parts.street
    const split = splitHouseStreet(houseStreet)
    if (split) {
      return { house: split.house, street: split.street, city: parts.city, state: parts.state.toUpperCase(), zip: parts.zip }
    }
  }

  // 2. Parse a comma-delimited free-form address.
  const m = raw.trim().match(/^(.+?),\s*([^,]+?),\s*([A-Za-z]{2})\b[,\s]*(\d{5}(?:-\d{4})?)?/)
  if (!m) return null
  const split = splitHouseStreet(m[1]!.trim())
  if (!split) return null
  return {
    house: split.house,
    street: split.street,
    city: m[2]!.trim(),
    state: m[3]!.toUpperCase(),
    zip: m[4]?.trim(),
  }
}
