import { Hono, type Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/db'
import { mapsSavedPins } from '@/db/schema'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { catalogTree, getRegion, listCatalog } from '@/lib/maps/catalog'
import { listRegionsForApi } from '@/lib/maps/store'
import { search, reverse } from '@/lib/maps/geocoder'
import { route as routeRequest, eta as etaRequest, RouteUnavailableError, type RouterMode } from '@/lib/maps/graphhopper'
import { isMapsToolchainInstalled } from '@/lib/maps/toolchain'
import {
  mapsGlyphsDir, overviewPmtilesPath, regionDemPath, regionLandcoverPath, regionTilesPath,
  worldCountriesPath, worldLabelsPath, worldStatesPath,
} from '@/lib/maps/paths'

const maps = new Hono<AppEnv>()

// ── Public map assets ──────────────────────────────────────────────────────────
// Tiles, glyphs, and the overview are fetched by MapLibre, which can't follow an
// auth redirect — so they serve without requireAuth (non-sensitive static map
// data, same as the ZIM `/view` proxy). This also prevents a 401 error-flood if
// the session expires while the map is open. Everything below stays protected.
maps.get('/tiles/_overview/streets.pmtiles', (c) => serveFile(c, overviewPmtilesPath(), 'application/octet-stream'))
maps.get('/tiles/_overview/world-countries.geojson', (c) => serveOverviewGeojson(c, worldCountriesPath()))
maps.get('/tiles/_overview/world-states.geojson', (c) => serveOverviewGeojson(c, worldStatesPath()))
maps.get('/tiles/_overview/world-labels.geojson', (c) => serveOverviewGeojson(c, worldLabelsPath()))
maps.get('/tiles/:regionId/streets.pmtiles', (c) => {
  const regionId = c.req.param('regionId')
  if (!getRegion(regionId)) return c.json({ detail: 'unknown_region' }, 404)
  return serveFile(c, regionTilesPath(regionId), 'application/octet-stream')
})
maps.get('/tiles/:regionId/dem.pmtiles', (c) => {
  const regionId = c.req.param('regionId')
  if (!getRegion(regionId)) return c.json({ detail: 'unknown_region' }, 404)
  return serveFile(c, regionDemPath(regionId), 'application/octet-stream')
})
maps.get('/tiles/:regionId/landcover.pmtiles', (c) => {
  const regionId = c.req.param('regionId')
  if (!getRegion(regionId)) return c.json({ detail: 'unknown_region' }, 404)
  return serveFile(c, regionLandcoverPath(regionId), 'application/octet-stream')
})
maps.get('/glyphs/:fontstack/:range', (c) => {
  const fontstack = decodeURIComponent(c.req.param('fontstack'))
  const range = c.req.param('range')
  if (!range.endsWith('.pbf') || !/^\d+-\d+\.pbf$/.test(range)) return c.json({ detail: 'invalid_glyph_range' }, 400)
  let resolved: string | null = null
  for (const raw of fontstack.split(',')) {
    const candidate = FONT_ALIASES[raw.trim().toLowerCase()]
    if (candidate && existsSync(join(mapsGlyphsDir, candidate))) { resolved = candidate; break }
  }
  if (!resolved && existsSync(join(mapsGlyphsDir, 'Noto Sans Regular'))) resolved = 'Noto Sans Regular'
  if (!resolved) return c.json({ detail: 'glyph_font_not_installed' }, 404)
  return serveFile(c, join(mapsGlyphsDir, resolved, range), 'application/x-protobuf')
})

// ── Everything below requires auth ──────────────────────────────────────────────
maps.use('*', requireAuth)

const PIN_COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray'])

// ── Static file serving with HTTP Range support (pmtiles needs byte ranges) ────
// pmtiles.js issues many small Range requests against the archive, so the range
// branch MUST return exactly the requested bytes. Read them precisely with
// fs.readSync — Bun.file().slice() did NOT honor the slice here and streamed the
// whole file, which made pmtiles read garbage and the map render blank.
function serveFile(c: Context<AppEnv>, path: string, contentType: string): Response {
  if (!existsSync(path)) return c.json({ detail: 'not_installed' }, 404)
  const size = statSync(path).size
  const range = c.req.header('range')
  const baseHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  }
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/)
    if (m?.[1]) {
      const start = parseInt(m[1], 10)
      const end = m[2] ? parseInt(m[2], 10) : size - 1
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const len = end - start + 1
      const buf = Buffer.allocUnsafe(len)
      const fd = openSync(path, 'r')
      try { readSync(fd, buf, 0, len, start) } finally { closeSync(fd) }
      return new Response(buf, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(len),
        },
      })
    }
  }
  return new Response(Bun.file(path), { status: 200, headers: { ...baseHeaders, 'Content-Length': String(size) } })
}

// ── Status ────────────────────────────────────────────────────────────────────
maps.get('/status', (c) => {
  return c.json({
    toolchainInstalled: isMapsToolchainInstalled(),
    regions: listRegionsForApi().length,
  })
})

// ── Catalog + installed regions ────────────────────────────────────────────────
maps.get('/catalog', (c) => c.json({ regions: catalogTree() }))
maps.get('/catalog/flat', (c) => c.json({ regions: listCatalog() }))
maps.get('/regions', (c) => c.json(listRegionsForApi()))

// ── Geocode ─────────────────────────────────────────────────────────────────
maps.get('/geocode', (c) => {
  const q = c.req.query('q') ?? ''
  const category = c.req.query('category') ?? null
  const limit = Math.min(parseInt(c.req.query('limit') ?? '10', 10) || 10, 25)
  const latS = c.req.query('lat')
  const lonS = c.req.query('lon')
  const center = latS && lonS ? { lat: Number(latS), lon: Number(lonS) } : null
  if (!q.trim() && !category) return c.json({ results: [], fallback_used: false, offline: true })
  const { results, offline } = search({ query: q, center, category, limit })
  return c.json({ results, fallback_used: false, offline })
})

maps.get('/geocode/reverse', (c) => {
  const lat = Number(c.req.query('lat'))
  const lon = Number(c.req.query('lon'))
  const radiusKm = Number(c.req.query('radius_km') ?? '0.05')
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return c.json({ detail: 'lat/lon required' }, 400)
  const result = reverse(lat, lon, radiusKm)
  if (!result) return c.json({ detail: 'not_found' }, 404)
  return c.json(result)
})

// ── Routing ───────────────────────────────────────────────────────────────────
maps.post('/route', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!body?.origin || !body?.destination) return c.json({ detail: 'origin and destination required' }, 400)
  try {
    const resp = await routeRequest({
      origin: body.origin,
      destination: body.destination,
      waypoints: Array.isArray(body.waypoints) ? body.waypoints : [],
      profile: (body.profile ?? 'auto') as RouterMode,
      alternates: (body.alternates ?? 0) as 0 | 1 | 2,
      avoid: body.avoid ?? { highways: false, tolls: false, ferries: false },
    })
    return c.json(resp)
  } catch (err) {
    if (err instanceof RouteUnavailableError) {
      c.header('Retry-After', String(err.retryAfterSeconds ?? 30))
      return c.json({ detail: err.message }, 503)
    }
    return c.json({ detail: String(err) }, 500)
  }
})

maps.get('/eta', async (c) => {
  const o = { lat: Number(c.req.query('from_lat')), lon: Number(c.req.query('from_lon')) }
  const d = { lat: Number(c.req.query('to_lat')), lon: Number(c.req.query('to_lon')) }
  const profile = (c.req.query('profile') ?? 'auto') as RouterMode
  if (![o.lat, o.lon, d.lat, d.lon].every(Number.isFinite)) return c.json({ detail: 'coords required' }, 400)
  try {
    return c.json(await etaRequest(o, d, profile))
  } catch (err) {
    if (err instanceof RouteUnavailableError) return c.json({ detail: err.message }, 503)
    return c.json({ detail: String(err) }, 500)
  }
})

// ── Saved pins ──────────────────────────────────────────────────────────────
function pinToJson(r: typeof mapsSavedPins.$inferSelect) {
  return {
    pin_id: r.pinId,
    label: r.label,
    lat: r.lat,
    lon: r.lon,
    color: r.color,
    place_ref: r.placeRefJson ? JSON.parse(r.placeRefJson) : null,
    created_at: r.createdAt,
    notes: r.notes ?? null,
    collection_id: r.collectionId ?? null,
  }
}

maps.get('/pins', (c) => {
  const user = c.get('user')
  const rows = db.select().from(mapsSavedPins).where(eq(mapsSavedPins.userId, user.id)).all()
  return c.json({ pins: rows.map(pinToJson) })
})

maps.post('/pins', async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null)
  const label = (body?.label ?? '').trim()
  if (!label) return c.json({ detail: 'label is required' }, 400)
  if (!PIN_COLORS.has(body?.color)) return c.json({ detail: `unsupported color: ${body?.color}` }, 400)
  const lat = Number(body.lat), lon = Number(body.lon)
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) return c.json({ detail: 'lat/lon out of range' }, 400)
  const row = {
    pinId: crypto.randomUUID(),
    userId: user.id,
    label,
    lat,
    lon,
    color: body.color,
    placeRefJson: body.place_ref ? JSON.stringify(body.place_ref) : null,
    notes: body.notes ?? null,
    collectionId: body.collection_id ?? null,
    createdAt: new Date().toISOString(),
  }
  db.insert(mapsSavedPins).values(row).run()
  return c.json(pinToJson(row))
})

maps.patch('/pins/:pinId', async (c) => {
  const user = c.get('user')
  const pinId = c.req.param('pinId')
  const existing = db.select().from(mapsSavedPins)
    .where(and(eq(mapsSavedPins.pinId, pinId), eq(mapsSavedPins.userId, user.id))).get()
  if (!existing) return c.json({ detail: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const patch: Partial<typeof mapsSavedPins.$inferInsert> = {}
  if (typeof body.label === 'string') patch.label = body.label.trim()
  if (Number.isFinite(body.lat)) patch.lat = Number(body.lat)
  if (Number.isFinite(body.lon)) patch.lon = Number(body.lon)
  if (typeof body.color === 'string' && PIN_COLORS.has(body.color)) patch.color = body.color
  if (body.place_ref_clear && body.place_ref == null) patch.placeRefJson = null
  else if (body.place_ref != null) patch.placeRefJson = JSON.stringify(body.place_ref)
  if (body.notes_clear && body.notes == null) patch.notes = null
  else if (body.notes != null) patch.notes = body.notes
  if (body.collection_id !== undefined) patch.collectionId = body.collection_id
  db.update(mapsSavedPins).set(patch)
    .where(and(eq(mapsSavedPins.pinId, pinId), eq(mapsSavedPins.userId, user.id))).run()
  const updated = db.select().from(mapsSavedPins)
    .where(and(eq(mapsSavedPins.pinId, pinId), eq(mapsSavedPins.userId, user.id))).get()!
  return c.json(pinToJson(updated))
})

maps.delete('/pins/:pinId', (c) => {
  const user = c.get('user')
  const pinId = c.req.param('pinId')
  const existing = db.select().from(mapsSavedPins)
    .where(and(eq(mapsSavedPins.pinId, pinId), eq(mapsSavedPins.userId, user.id))).get()
  if (!existing) return c.json({ detail: 'not_found' }, 404)
  db.delete(mapsSavedPins)
    .where(and(eq(mapsSavedPins.pinId, pinId), eq(mapsSavedPins.userId, user.id))).run()
  return c.json({ ok: true })
})

// Pin collections — not yet implemented; return empty so the UI degrades.
maps.get('/collections', (c) => c.json({ collections: [] }))

// Tile + overview serving is registered as public above (before requireAuth).
function serveOverviewGeojson(c: Context<AppEnv>, path: string): Response {
  // Overview vector data is optional; return an empty FeatureCollection when
  // not present so the map's world-view layers simply render nothing.
  if (!existsSync(path)) {
    return c.json({ type: 'FeatureCollection', features: [] })
  }
  return serveFile(c, path, 'application/geo+json')
}

// Glyph fontstack aliases — Planetiler bakes "Open Sans"/"Arial Unicode" font
// names into tiles; we only ship Noto Sans, so alias to the nearest variant.
// The /glyphs route itself is registered as public above (before requireAuth).
const FONT_ALIASES: Record<string, string> = {
  'open sans regular': 'Noto Sans Regular',
  'open sans medium': 'Noto Sans Medium',
  'open sans italic': 'Noto Sans Italic',
  'open sans bold': 'Noto Sans Medium',
  'open sans semibold': 'Noto Sans Medium',
  'arial unicode ms regular': 'Noto Sans Regular',
  'noto sans regular': 'Noto Sans Regular',
  'noto sans medium': 'Noto Sans Medium',
  'noto sans italic': 'Noto Sans Italic',
}

// ── Favicon proxy (POI brand favicons) ─────────────────────────────────────────
maps.get('/favicon', async (c) => {
  const host = c.req.query('host')
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) return c.body(null, 400)
  try {
    const res = await fetch(`https://${host}/favicon.ico`, {
      signal: AbortSignal.timeout(5_000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible)' },
    })
    if (!res.ok || !res.body) return c.body(null, 404)
    return new Response(res.body, {
      headers: {
        'Content-Type': res.headers.get('content-type') ?? 'image/x-icon',
        'Cache-Control': 'public, max-age=604800',
      },
    })
  } catch {
    return c.body(null, 404)
  }
})

// ── Brand logos / POI photos / incidents — graceful empty responses ────────────
// These were enrichment layers in v2 backed by cached external assets. Not yet
// ported; return 404/empty so the frontend falls back to lucide icons cleanly.
maps.get('/logos/:file', (c) => c.body(null, 404))
maps.get('/poi-photo/*', (c) => c.body(null, 404))
maps.get('/incidents', (c) => c.json({ incidents: [] }))

export { maps }
