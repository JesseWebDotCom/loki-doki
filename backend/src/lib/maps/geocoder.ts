// Offline geocoder — FTS5 search + reverse lookup over per-region SQLite
// databases. Ported from v2 lokidoki/maps/geocode/. Each installed region has a
// `geocoder.sqlite` with an FTS5 `places` table and an `places_rtree` spatial
// index. Search is in-process linear over the small set of installed regions.

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { getRegion } from '@/lib/maps/catalog'
import { regionGeocoderPath } from '@/lib/maps/paths'
import { listInstalledRegions } from '@/lib/maps/store'

export interface GeocodeResult {
  place_id: string
  title: string
  subtitle: string
  lat: number
  lon: number
  bbox: [number, number, number, number] | null
  source: 'fts' | 'nominatim'
  category: string | null
  phone: string | null
  website: string | null
  distance_m: number | null
  opening_hours_raw: string | null
  open_now: boolean | null
  closes_at: string | null
  opens_at: string | null
  business_attrs: Record<string, unknown> | null
  brand_qid: string | null
  wiki_summary: string | null
  wiki_url: string | null
}

const FTS_STRIP = new Set(['"', '(', ')', '*', ':'])
const MIN_TOKEN_LEN = 2
const PER_REGION_LIMIT = 25
const BUCKET_WEIGHT = 1_000_000
const STOPWORDS = new Set(['in', 'at', 'on', 'near', 'by', 'of', 'the'])
const US_STATE_ABBREV = new Set([
  'al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia','ks','ky','la','me','md',
  'ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd','oh','ok','or','pa','ri','sc',
  'sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc',
])

function tokenise(query: string): string[] {
  const out: string[] = []
  for (const raw of query.replace(/,/g, ' ').split(/\s+/)) {
    const cleaned = [...raw].filter((ch) => !FTS_STRIP.has(ch)).join('').trim()
    const lowered = cleaned.toLowerCase()
    if (US_STATE_ABBREV.has(lowered) || STOPWORDS.has(lowered)) continue
    if (cleaned.length >= MIN_TOKEN_LEN) out.push(cleaned)
  }
  return out
}

function buildMatch(query: string): string | null {
  const tokens = tokenise(query)
  if (tokens.length === 0) return null
  const parts = tokens.slice(0, -1).map((t) => `"${t}"`)
  parts.push(`"${tokens[tokens.length - 1]}"*`)
  return parts.join(' ')
}

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function textMatchBucket(title: string, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const titleL = title.toLowerCase()
  const joined = tokens.map((t) => t.toLowerCase()).join(' ')
  if (titleL.startsWith(joined)) return 3
  const words = titleL.split(/\s+/)
  if (tokens.every((t) => words.some((w) => w.startsWith(t.toLowerCase())))) return 2
  if (tokens.every((t) => titleL.includes(t.toLowerCase()))) return 1
  return 0
}

function formatSubtitle(city: string, admin1: string, postcode: string): string {
  return [city, admin1, postcode].filter(Boolean).join(', ')
}

interface DbCache { db: Database; mtime: number }
const dbCache = new Map<string, DbCache>()

function openRegionDb(regionId: string): Database | null {
  const path = regionGeocoderPath(regionId)
  if (!existsSync(path)) return null
  const cached = dbCache.get(regionId)
  if (cached) return cached.db
  try {
    const db = new Database(path, { readonly: true })
    dbCache.set(regionId, { db, mtime: Date.now() })
    return db
  } catch {
    return null
  }
}

interface PlaceRow {
  osm_id: string | number
  name: string
  housenumber: string
  street: string
  city: string
  postcode: string
  admin1: string
  phone: string
  website: string
  lat: number
  lon: number
  class: string
  opening_hours: string | null
  business_attrs: string | null
  brand_qid: string | null
  wiki_summary: string | null
  wiki_url: string | null
}

function rowToResult(
  row: PlaceRow,
  regionId: string,
  center: { lat: number; lon: number } | null,
  tokens: string[],
): GeocodeResult {
  const lat = Number(row.lat)
  const lon = Number(row.lon)
  const streetLine = `${row.housenumber ?? ''} ${row.street ?? ''}`.trim()
  const name = (row.name ?? '').trim()
  const title = name || streetLine || String(row.osm_id)
  const locality = formatSubtitle(row.city ?? '', row.admin1 ?? '', row.postcode ?? '')
  let subtitle: string
  if (name && streetLine && streetLine !== title) {
    subtitle = locality ? `${streetLine}, ${locality}` : streetLine
  } else {
    subtitle = locality
  }
  let distance_m: number | null = null
  if (center) distance_m = haversineKm(center, { lat, lon }) * 1000

  let businessAttrs: Record<string, unknown> | null = null
  if (row.business_attrs) {
    try { businessAttrs = JSON.parse(row.business_attrs) } catch { /* ignore */ }
  }
  return {
    place_id: `${regionId}:osm:${row.osm_id}`,
    title,
    subtitle,
    lat,
    lon,
    bbox: null,
    source: 'fts',
    category: row.class ? String(row.class) : null,
    phone: (row.phone ?? '').trim() || null,
    website: (row.website ?? '').trim() || null,
    distance_m,
    opening_hours_raw: (row.opening_hours ?? '')?.toString().trim() || null,
    open_now: null,
    closes_at: null,
    opens_at: null,
    business_attrs: businessAttrs,
    brand_qid: (row.brand_qid ?? '')?.toString().trim() || null,
    wiki_summary: (row.wiki_summary ?? '')?.toString().trim() || null,
    wiki_url: (row.wiki_url ?? '')?.toString().trim() || null,
  }
}

function tableColumns(db: Database, table: string): Set<string> {
  try {
    const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
    return new Set(rows.map((r) => r.name))
  } catch {
    return new Set()
  }
}

function searchRegion(
  regionId: string,
  matchExpr: string | null,
  center: { lat: number; lon: number } | null,
  category: string | null,
  tokens: string[],
): GeocodeResult[] {
  const db = openRegionDb(regionId)
  if (!db) return []
  const cols = tableColumns(db, 'places')
  if (cols.size === 0) return []

  const select = [
    'osm_id', 'name', 'housenumber', 'street', 'city', 'postcode', 'admin1',
    'phone', 'website', 'lat', 'lon', 'class', 'opening_hours', 'business_attrs',
    'brand_qid', 'wiki_summary', 'wiki_url',
  ].filter((c) => cols.has(c))

  const where: string[] = []
  const params: unknown[] = []
  if (matchExpr) {
    where.push('places MATCH ?')
    params.push(matchExpr)
  }
  if (category) {
    where.push("class LIKE ?")
    params.push(`poi:${category}%`)
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const sql = `SELECT ${select.join(', ')} FROM places ${whereClause} LIMIT ${PER_REGION_LIMIT}`

  let rows: PlaceRow[]
  try {
    rows = db.query(sql).all(...(params as never[])) as PlaceRow[]
  } catch {
    return []
  }
  return rows.map((r) => rowToResult(r, regionId, center, tokens))
}

function rankedRegions(center: { lat: number; lon: number } | null): string[] {
  const installed = listInstalledRegions().filter((r) => r.geocoderInstalled)
  if (!center) return installed.map((r) => r.regionId)
  // Prefer regions whose bbox contains the center, then by distance to center.
  const scored = installed.map((r) => {
    const region = getRegion(r.regionId)
    if (!region) return { id: r.regionId, contains: false, dist: Infinity }
    const [minLon, minLat, maxLon, maxLat] = region.bbox
    const contains = center.lon >= minLon && center.lon <= maxLon && center.lat >= minLat && center.lat <= maxLat
    const dist = haversineKm(center, region.center)
    return { id: r.regionId, contains, dist }
  })
  scored.sort((a, b) => (a.contains === b.contains ? a.dist - b.dist : a.contains ? -1 : 1))
  return scored.map((s) => s.id)
}

export interface SearchOptions {
  query: string
  center: { lat: number; lon: number } | null
  category: string | null
  limit: number
}

export function search(opts: SearchOptions): { results: GeocodeResult[]; offline: boolean } {
  const matchExpr = buildMatch(opts.query)
  const tokens = tokenise(opts.query)
  const regions = rankedRegions(opts.center)
  const all: GeocodeResult[] = []
  for (const regionId of regions) {
    all.push(...searchRegion(regionId, matchExpr, opts.center, opts.category, tokens))
    if (all.length >= opts.limit * 4) break
  }
  // Rank: text bucket dominates, distance breaks ties (closer wins).
  const scored = all.map((r) => {
    const distKm = r.distance_m != null ? r.distance_m / 1000 : 0
    const bucket = textMatchBucket(r.title, tokens)
    return { r, score: bucket * BUCKET_WEIGHT - distKm }
  })
  scored.sort((a, b) => b.score - a.score)

  // Dedup by rounded coordinate + title.
  const seen = new Set<string>()
  const results: GeocodeResult[] = []
  for (const { r } of scored) {
    const key = `${r.title.toLowerCase()}@${r.lat.toFixed(4)},${r.lon.toFixed(4)}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push(r)
    if (results.length >= opts.limit) break
  }
  return { results, offline: true }
}

export function reverse(lat: number, lon: number, radiusKm: number): GeocodeResult | null {
  const center = { lat, lon }
  const latDelta = radiusKm / 110.574
  const lonScale = Math.max(0.1, Math.abs(Math.cos((lat * Math.PI) / 180)))
  const lonDelta = radiusKm / (111.32 * lonScale)
  for (const regionId of rankedRegions(center)) {
    const db = openRegionDb(regionId)
    if (!db) continue
    const cols = tableColumns(db, 'places')
    if (cols.size === 0) continue
    try {
      const rows = db.query(
        `SELECT * FROM places WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 50`,
      ).all(lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta) as PlaceRow[]
      if (rows.length === 0) continue
      let best: GeocodeResult | null = null
      let bestDist = Infinity
      for (const row of rows) {
        const d = haversineKm(center, { lat: Number(row.lat), lon: Number(row.lon) })
        if (d < bestDist) {
          bestDist = d
          best = rowToResult(row, regionId, center, [])
        }
      }
      if (best) return best
    } catch { /* try next region */ }
  }
  return null
}

export function invalidateGeocoderCache(regionId?: string): void {
  if (regionId) {
    dbCache.get(regionId)?.db.close()
    dbCache.delete(regionId)
    return
  }
  for (const { db } of dbCache.values()) db.close()
  dbCache.clear()
}
