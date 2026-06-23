// Property record lookup via Vision Government Solutions (gis.vgsi.com) — the public
// online assessor database many New England municipalities publish. This data is public
// record (appraised value, lot, building specs, sale history). Site-specific glue only:
// the HTTP, HTML-table, and caching mechanics all come from the shared primitives in
// lib/scrape.ts + lib/lookupCache.ts, so the scraping machinery is reusable elsewhere.
//
// Two-step navigation, mirroring how a person browses the site:
//   1. {base}/Streets.aspx?Name={STREET}  → list of parcels on that street; find the <a>
//      whose link text starts with our house number and grab its pid.
//   2. {base}/Parcel.aspx?pid={pid}       → the parcel card; parse its label/value tables.
// base = https://gis.vgsi.com/{citySlug}{state}.

import { fetchHtml, parseLabelValueTable } from '@/lib/scrape'
import { cachedLookup, THIRTY_DAYS_MS } from '@/lib/lookupCache'
import { normalizeStreet } from '@/lib/addressParse'

export interface PropertyDetails {
  address: string | null
  owner: string | null
  coOwner: string | null
  yearBuilt: number | null
  livingAreaSqft: number | null
  style: string | null
  stories: string | null
  bedrooms: number | null
  bathrooms: number | null
  halfBaths: number | null
  lotAcres: number | null
  appraisedValue: string | null
  landValue: string | null
  lastSalePrice: string | null
  lastSaleDate: string | null
  zoning: string | null
  useDescription: string | null
  heatFuel: string | null
  heatType: string | null
  acType: string | null
  exteriorWall: string | null
  features: string[]
  sourceUrl: string | null
}

export interface PropertyQuery {
  house: string
  street: string
  city: string
  state: string
}

// VGSI building feature codes → human labels (codes appear as bare cells on the card).
const FEATURE_CODES: Record<string, string> = {
  FPL: 'Fireplace', FGR: 'Garage', WDK: 'Deck', GAZ: 'Gazebo', SFB: 'Finished Basement',
  FEP: 'Enclosed Porch', OFP: 'Open Porch', ATT: 'Attic', HOT: 'Hot Tub', PTO: 'Patio',
  SPK: 'Sprinkler System', SEC: 'Security System', CNP: 'Canopy', PLG: 'In-Ground Pool',
}

function toInt(v: string | undefined): number | null {
  if (!v) return null
  const m = v.replace(/,/g, '').match(/\d+/)
  return m ? parseInt(m[0], 10) : null
}

function toFloat(v: string | undefined): number | null {
  if (!v) return null
  const m = v.replace(/,/g, '').match(/\d+(?:\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}

/** First non-empty value among several candidate labels. */
function pick(table: Map<string, string>, ...labels: string[]): string | undefined {
  for (const l of labels) {
    const v = table.get(l.toLowerCase())
    if (v) return v
  }
  return undefined
}

function citySlug(city: string): string {
  return city.toLowerCase().replace(/[\s.]/g, '')
}

/**
 * Find the parcel pid on a Streets.aspx page whose link text starts with `house`.
 * VGSI markup: <li><a href='Parcel.aspx?pid=13648'>687 NEW HAVEN AVE</a> ...</li>
 * (note: single-quoted hrefs, link text = "<house> <STREET>"). Accept either quote style.
 */
function findPid(html: string, house: string): string | null {
  const linkRe = /<a[^>]*href=["']([^"']*[Pp]arcel\.aspx[^"']*?pid=(\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi
  const houseRe = new RegExp(`^${house.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html))) {
    const text = m[3]!.replace(/<[^>]+>/g, '').trim()
    if (houseRe.test(text)) return m[2]!
  }
  return null
}

function parseParcelCard(html: string, sourceUrl: string): PropertyDetails {
  const table = parseLabelValueTable(html)

  // Building feature codes show up as standalone cells anywhere on the card.
  const features: string[] = []
  for (const [code, label] of Object.entries(FEATURE_CODES)) {
    if (new RegExp(`\\b${code}\\b`).test(html) && !features.includes(label)) features.push(label)
  }

  return {
    address: pick(table, 'Address') ?? null,
    owner: pick(table, 'Owner') ?? null,
    coOwner: pick(table, 'Co-Owner') ?? null,
    yearBuilt: toInt(pick(table, 'Year Built')),
    livingAreaSqft: toInt(pick(table, 'Living Area')),
    style: pick(table, 'Style') ?? null,
    stories: pick(table, 'Stories') ?? null,
    bedrooms: toInt(pick(table, 'Total Bedrooms')),
    bathrooms: toInt(pick(table, 'Total Bthrms', 'Total Bathrooms')),
    halfBaths: toInt(pick(table, 'Total Half Baths', 'Half Baths')),
    lotAcres: toFloat(pick(table, 'Size (Acres)', 'Lot Size')),
    appraisedValue: pick(table, 'Appraised Value') ?? null,
    landValue: pick(table, 'Total Market Land', 'Land Value') ?? null,
    lastSalePrice: pick(table, 'Sale Price') ?? null,
    lastSaleDate: pick(table, 'Sale Date') ?? null,
    zoning: pick(table, 'Zone') ?? null,
    useDescription: pick(table, 'Description') ?? null,
    heatFuel: pick(table, 'Heat Fuel') ?? null,
    heatType: pick(table, 'Heat Type') ?? null,
    acType: pick(table, 'AC Type') ?? null,
    exteriorWall: pick(table, 'Exterior Wall 1', 'Exterior Wall') ?? null,
    features,
    sourceUrl,
  }
}

async function fetchProperty(q: PropertyQuery): Promise<PropertyDetails | null> {
  const base = `https://gis.vgsi.com/${citySlug(q.city)}${q.state.toLowerCase()}`
  const street = normalizeStreet(q.street)

  const streetsHtml = await fetchHtml(`${base}/Streets.aspx?Name=${encodeURIComponent(street)}`)
  if (!streetsHtml) return null
  const pid = findPid(streetsHtml, q.house)
  if (!pid) return null

  const parcelUrl = `${base}/Parcel.aspx?pid=${pid}`
  const parcelHtml = await fetchHtml(parcelUrl)
  if (!parcelHtml) return null
  return parseParcelCard(parcelHtml, parcelUrl)
}

/**
 * Look up assessor property details for a street address. Cached 30 days (negative results
 * included). Returns null when the municipality isn't on VGSI, the parcel isn't found, or
 * the site blocks the request — callers must handle null.
 */
export async function lookupProperty(q: PropertyQuery): Promise<PropertyDetails | null> {
  if (!q.house || !q.street || !q.city || !q.state) return null
  const key = `${q.house}|${q.street}|${q.city}|${q.state}`
  return cachedLookup('property', key, THIRTY_DAYS_MS, () => fetchProperty(q))
}
