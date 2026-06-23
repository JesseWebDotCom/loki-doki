// People lookup via ThatsThem (thatsthem.com) — free, keyless reverse directory. Three
// query modes (address → residents, name → people, phone → owner). ThatsThem embeds its
// results as JSON-LD Person nodes, so parsing is just: extract JSON-LD (shared helper),
// keep @type=Person, normalise, dedup. HTTP + caching come from the shared primitives.
//
// Privacy note: this surfaces names + phone numbers tied to addresses. It is for personal
// reference only; do NOT use it for any FCRA-regulated purpose (tenant/employment/credit).

import { fetchHtml, extractJsonLd } from '@/lib/scrape'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { normalizeStreet } from '@/lib/addressParse'

export interface PersonAddress {
  street: string
  city: string
  state: string
  zip: string
  lat: number | null
  lng: number | null
}

export interface PersonRecord {
  name: string
  givenName: string | null
  familyName: string | null
  middleName: string | null
  phones: string[]
  emails: string[]
  addresses: PersonAddress[]
  associates: string[]
  profileUrl: string | null
}

const BASE = 'https://thatsthem.com'

/** Build a hyphenated URL slug from address/name parts (alnum + spaces only). */
function slug(...parts: string[]): string {
  const tokens: string[] = []
  for (const part of parts) {
    for (const word of part.replace(/[^a-zA-Z0-9\s]/g, '').trim().split(/\s+/)) {
      if (word) tokens.push(word)
    }
  }
  return tokens.join('-').toLowerCase()
}

function asArray(v: unknown): string[] {
  if (v == null) return []
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string')
  return typeof v === 'string' ? [v] : []
}

/** ThatsThem sometimes encodes lat/lng as scaled integers (41243115 → 41.243115). */
function normCoord(v: unknown, max: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN
  if (!Number.isFinite(n)) return null
  return Math.abs(n) > max ? n / 1_000_000 : n
}

function parseAddress(place: Record<string, unknown>): PersonAddress | null {
  const addr = place.address as Record<string, unknown> | undefined
  if (!addr) return null
  const geo = place.geo as Record<string, unknown> | undefined
  const zipRaw = typeof addr.postalCode === 'string' ? addr.postalCode : ''
  return {
    street: typeof addr.streetAddress === 'string' ? addr.streetAddress : '',
    city: typeof addr.addressLocality === 'string' ? addr.addressLocality : '',
    state: typeof addr.addressRegion === 'string' ? addr.addressRegion : '',
    zip: zipRaw.split('-')[0]!.slice(0, 5),
    lat: normCoord(geo?.latitude, 90),
    lng: normCoord(geo?.longitude, 180),
  }
}

function toRecord(node: Record<string, unknown>): PersonRecord | null {
  const name = typeof node.name === 'string' ? node.name.trim() : ''
  if (!name) return null

  const homeLocations = Array.isArray(node.homeLocation)
    ? node.homeLocation
    : node.homeLocation
      ? [node.homeLocation]
      : []
  const addresses = (homeLocations as Record<string, unknown>[])
    .map(parseAddress)
    .filter((a): a is PersonAddress => a != null && Boolean(a.street))

  const knows = Array.isArray(node.knows) ? node.knows : node.knows ? [node.knows] : []
  const associates = (knows as Record<string, unknown>[])
    .map((k) => (typeof k.name === 'string' ? k.name.trim() : ''))
    .filter(Boolean)

  return {
    name,
    givenName: typeof node.givenName === 'string' ? node.givenName : null,
    familyName: typeof node.familyName === 'string' ? node.familyName : null,
    middleName: typeof node.additionalName === 'string' ? node.additionalName : null,
    phones: asArray(node.telephone),
    emails: asArray(node.email),
    addresses,
    associates,
    profileUrl: typeof node.url === 'string' ? node.url : typeof node['@id'] === 'string' ? (node['@id'] as string) : null,
  }
}

/** Drop obvious garbage and merge duplicate people (keeping the richer record). */
function cleanRecords(records: PersonRecord[]): PersonRecord[] {
  const merged = new Map<string, PersonRecord>()
  for (const r of records) {
    const words = r.name.split(/\s+/).filter(Boolean)
    if (words.length < 2) continue
    if (r.familyName && (r.familyName.includes(' ') || r.familyName.length < 2)) continue

    // Include the middle name in the identity key so distinct same-first/last people
    // (e.g. several "John Smith"s in a name search) stay separate, while ThatsThem's
    // true duplicate nodes for one person still collapse.
    const key = (r.givenName && r.familyName
      ? `${r.givenName}|${r.middleName ?? ''}|${r.familyName}`
      : r.name
    ).toLowerCase().replace(/\s+/g, ' ').trim()

    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, r)
    } else {
      if (r.name.length > existing.name.length) existing.name = r.name
      existing.phones = [...new Set([...existing.phones, ...r.phones])]
      existing.emails = [...new Set([...existing.emails, ...r.emails])]
      if (r.addresses.length > existing.addresses.length) existing.addresses = r.addresses
    }
  }
  return [...merged.values()]
}

async function scrape(url: string): Promise<PersonRecord[]> {
  const html = await fetchHtml(url, { headers: { 'Cache-Control': 'no-cache' } })
  if (!html) return []
  const people = extractJsonLd(html)
    .filter((n) => n['@type'] === 'Person')
    .map(toRecord)
    .filter((r): r is PersonRecord => r != null)
  return cleanRecords(people)
}

// ── Public, cached lookups ────────────────────────────────────────────────────────

/**
 * Residents at an address. `street` MUST be the full street line INCLUDING the house
 * number ("74 Welchs Point Rd") — ThatsThem's address slug is keyed on the house number,
 * and a street-only slug ("welchs-point-rd…") resolves to a generic page that returns one
 * unrelated person. Callers that hold house + street separately must join them first.
 */
export async function lookupPeopleByAddress(
  street: string,
  city: string,
  state: string,
  zip?: string,
): Promise<PersonRecord[]> {
  if (!street || !city || !state) return []
  let s = slug(street, city, state.toUpperCase())
  if (zip) s += `-${zip.replace(/\D/g, '').slice(0, 5)}`
  const url = `${BASE}/address/${s}`
  const key = `address|${street}|${city}|${state}|${zip ?? ''}`
  const records = await cachedLookup('people', key, THIRTY_DAYS_MS, () => scrape(url))
  // Keep only residents whose street matches the queried street (the page can include
  // nearby/related addresses).
  const want = normalizeStreet(street)
  const filtered = records.filter((r) =>
    r.addresses.length === 0 || r.addresses.some((a) => normalizeStreet(a.street) === want),
  )
  return filtered.length ? filtered : records
}

export async function lookupPeopleByName(
  first: string,
  last: string,
  state?: string,
): Promise<PersonRecord[]> {
  if (!first || !last) return []
  const path = state ? `name/${slug(first, last)}/${state.toUpperCase()}` : `name/${slug(first, last)}`
  const key = `name|${first}|${last}|${state ?? ''}`
  return cachedLookup('people', key, THIRTY_DAYS_MS, () => scrape(`${BASE}/${path}`))
}

export async function lookupPeopleByPhone(phone: string): Promise<PersonRecord[]> {
  let digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  if (digits.length !== 10) return []
  const formatted = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  const key = `phone|${digits}`
  return cachedLookup('people', key, THIRTY_DAYS_MS, () => scrape(`${BASE}/phone/${formatted}`))
}
