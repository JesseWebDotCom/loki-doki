// Per-region terrain (hillshade) DEM build.
//
// Downloads pre-encoded "terrarium" elevation PNG tiles for the region's bbox
// from the public AWS Terrain Tiles open dataset (Mapzen/Nextzen joerd —
// s3://elevation-tiles-prod), packs them into a temporary MBTiles, then runs
// the already-installed go-pmtiles utility to convert that into a single
// dem.pmtiles archive served alongside streets.pmtiles.
//
// Online at BUILD time only (exactly like the Geofabrik PBF + planetiler base
// data). At runtime the map reads dem.pmtiles locally — no network. The tiles
// are already terrarium-encoded, so there is NO elevation-encoding / GDAL step.
//
// maxzoom 13 ("sharp"): hillshade is smooth, so MapLibre over-zooms beyond 13
// at street level. Identical ocean/flat tiles are de-duplicated by go-pmtiles,
// so flat regions stay small.

import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getRegion } from '@/lib/maps/catalog'
import { pmtilesBin, regionDemPath, regionDir } from '@/lib/maps/paths'
import { installPmtilesBin } from '@/lib/maps/toolchain'

export type TerrainEvent = { phase: 'building_terrain'; artifact: 'dem'; pct?: number; msg?: string }
type OnTerrainEvent = (e: TerrainEvent) => void

const TERRARIUM_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
const DEM_MIN_ZOOM = 5
// Smallest footprint: z11 is plenty for hillshade (it's smooth and the frontend
// over-zooms above it). ~30 MB/state vs ~480 MB at z13, with no visible loss for
// relief shading. Bump this only for a mountainous "hero" region if ever needed.
const DEM_MAX_ZOOM = 11
const FETCH_CONCURRENCY = 12
const MAX_LAT = 85.05112878 // web-mercator latitude limit

// ── Slippy-tile math ────────────────────────────────────────────────────────
function lon2tile(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z)
}
function lat2tile(lat: number, z: number): number {
  const r = (Math.min(MAX_LAT, Math.max(-MAX_LAT, lat)) * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}

function tilesForBbox(bbox: [number, number, number, number]): { z: number; x: number; y: number }[] {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const out: { z: number; x: number; y: number }[] = []
  for (let z = DEM_MIN_ZOOM; z <= DEM_MAX_ZOOM; z++) {
    const n = 2 ** z
    const clamp = (v: number) => Math.max(0, Math.min(n - 1, v))
    const x0 = clamp(lon2tile(minLon, z))
    const x1 = clamp(lon2tile(maxLon, z))
    const y0 = clamp(lat2tile(maxLat, z)) // north → smaller y
    const y1 = clamp(lat2tile(minLat, z))
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y })
  }
  return out
}

// ── Tile fetch (skip missing, retry transient) ──────────────────────────────
async function fetchTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Buffer | null> {
  const url = `${TERRARIUM_BASE}/${z}/${x}/${y}.png`
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
    try {
      const res = await fetch(url, { signal })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`status ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      if (attempt === 2) return null // give up on this tile; the region just loses one cell
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
    }
  }
  return null
}

// ── Temp MBTiles writer (go-pmtiles converts this → dem.pmtiles) ─────────────
function createMbtiles(path: string, meta: Record<string, string | number>): Database {
  const db = new Database(path, { create: true })
  db.exec(`
    CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
    CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
  `)
  const ins = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)')
  for (const [k, v] of Object.entries(meta)) ins.run(k, String(v))
  return db
}

function runPmtilesConvert(input: string, output: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pmtilesBin(), ['convert', input, output], { stdio: 'ignore' })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pmtiles convert exited ${code}`))))
    proc.on('error', reject)
    signal?.addEventListener('abort', () => {
      try { proc.kill('SIGTERM') } catch { /* gone */ }
      reject(new DOMException('Cancelled', 'AbortError'))
    })
  })
}

// Build dem.pmtiles for a region. Best-effort: returns false (no throw) when the
// pmtiles tool is missing or no tiles exist; throws only on abort / hard error.
export async function buildTerrain(regionId: string, onEvent: OnTerrainEvent, signal?: AbortSignal): Promise<boolean> {
  const region = getRegion(regionId)
  if (!region) throw new Error(`unknown region: ${regionId}`)
  if (!existsSync(pmtilesBin())) {
    // Self-heal: the pmtiles tool installs best-effort with the toolchain and
    // may be missing on older installs. Fetch it now rather than silently
    // skipping terrain forever.
    onEvent({ phase: 'building_terrain', artifact: 'dem', msg: 'Fetching pmtiles tool…' })
    try {
      await installPmtilesBin((m) => onEvent({ phase: 'building_terrain', artifact: 'dem', msg: m }), signal)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      onEvent({ phase: 'building_terrain', artifact: 'dem', msg: `Skipping hillshade — pmtiles tool unavailable (${String(err)})` })
      return false
    }
  }

  const dir = regionDir(regionId)
  await mkdir(dir, { recursive: true })
  const mbtilesPath = join(dir, 'dem.mbtiles')
  const demPath = regionDemPath(regionId)
  const cleanupTmp = async () => {
    for (const p of [mbtilesPath, `${mbtilesPath}-wal`, `${mbtilesPath}-shm`, `${mbtilesPath}-journal`]) {
      await rm(p, { force: true }).catch(() => {})
    }
  }
  await cleanupTmp()
  await rm(demPath, { force: true }).catch(() => {})

  const tiles = tilesForBbox(region.bbox)
  const total = tiles.length
  onEvent({ phase: 'building_terrain', artifact: 'dem', pct: 0, msg: `Downloading terrain (${total} tiles)…` })

  const db = createMbtiles(mbtilesPath, {
    name: `${regionId} terrain`, format: 'png', type: 'baselayer', version: '1',
    minzoom: DEM_MIN_ZOOM, maxzoom: DEM_MAX_ZOOM, bounds: region.bbox.join(','),
  })
  const insert = db.prepare('INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)')

  let idx = 0, done = 0, written = 0, lastPct = -1
  db.exec('BEGIN')
  const worker = async () => {
    while (true) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
      const i = idx++
      if (i >= total) break
      const t = tiles[i]!
      const buf = await fetchTile(t.z, t.x, t.y, signal)
      if (buf) {
        const tmsY = 2 ** t.z - 1 - t.y // MBTiles rows are TMS (flipped Y)
        insert.run(t.z, t.x, tmsY, buf)
        if (++written % 2000 === 0) { db.exec('COMMIT'); db.exec('BEGIN') }
      }
      done++
      const pct = Math.floor((done / total) * 100)
      if (pct !== lastPct) { lastPct = pct; onEvent({ phase: 'building_terrain', artifact: 'dem', pct, msg: `Terrain ${done}/${total} tiles` }) }
    }
  }

  try {
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => worker()))
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('COMMIT') } catch { /* ignore */ }
    db.close()
    await cleanupTmp()
    throw err
  }
  db.close()

  if (written === 0) {
    await cleanupTmp()
    onEvent({ phase: 'building_terrain', artifact: 'dem', msg: 'No terrain tiles available for this region' })
    return false
  }

  onEvent({ phase: 'building_terrain', artifact: 'dem', msg: 'Packing terrain into pmtiles…' })
  await runPmtilesConvert(mbtilesPath, demPath, signal)
  await cleanupTmp()
  return existsSync(demPath)
}
