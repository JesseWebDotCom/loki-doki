// Per-region satellite-derived landcover bake.
//
// Pulls ESA WorldCover (10 m, Sentinel-1/2 derived, public AWS Open Data — no
// auth) as Cloud-Optimized GeoTIFFs, samples the classified land cover for the
// region's web-mercator tiles, recolours each class to a naturalistic palette,
// and packs the result into a small landcover.pmtiles served under the vector
// map. Online at BUILD time only (geotiff.js reads just the bytes it needs via
// HTTP range); fully offline at runtime.
//
// Unlike the OSM `landcover` vector layer (sparse — only what mappers tagged),
// this colours EVERY acre: the rural land OSM leaves blank becomes real forest,
// cropland, grassland, water and wetland. Flat class colours deflate to almost
// nothing and go-pmtiles de-duplicates identical tiles, so the archive is tiny.

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fromUrl, type GeoTIFF } from 'geotiff'
import { getRegion } from '@/lib/maps/catalog'
import { pmtilesBin, regionDir, regionLandcoverPath } from '@/lib/maps/paths'
import { installPmtilesBin } from '@/lib/maps/toolchain'
import { createMbtiles, encodePngRGBA, mercY2lat, runPmtilesConvert, tilesForBbox } from '@/lib/maps/tilepack'

export type LandcoverEvent = { phase: 'building_landcover'; artifact: 'landcover'; pct?: number; msg?: string }
type OnEvent = (e: LandcoverEvent) => void

const WORLDCOVER_BASE = 'https://esa-worldcover.s3.amazonaws.com/v200/2021/map'
const LC_MIN_ZOOM = 5
const LC_MAX_ZOOM = 12
const TILE = 256

// ESA WorldCover class code → naturalistic RGB. Slightly desaturated so roads
// and labels stay legible on top. Undefined = transparent. Water (80) is left
// transparent ON PURPOSE: the crisp OSM vector water layer renders coastlines
// and lakes far better than a coarse 10 m raster cell, which would otherwise
// bleed navy blobs over near-shore land at high zoom.
const COLORS: Record<number, [number, number, number] | undefined> = {
  10: [106, 154, 91],   // tree cover
  20: [183, 199, 122],  // shrubland
  30: [201, 220, 160],  // grassland
  40: [232, 217, 160],  // cropland
  50: [214, 210, 203],  // built-up (OSM urban/buildings draw over)
  60: [217, 205, 184],  // bare / sparse vegetation
  70: [240, 244, 247],  // snow & ice
  // 80 water → transparent; vector water handles it
  90: [167, 198, 173],  // herbaceous wetland
  95: [111, 157, 118],  // mangroves
  100: [205, 214, 176], // moss & lichen
}

// ESA WorldCover ships in 3°×3° COGs named by their SW corner.
function cogName(latBase: number, lonBase: number): string {
  const la = (latBase < 0 ? 'S' : 'N') + String(Math.abs(latBase)).padStart(2, '0')
  const lo = (lonBase < 0 ? 'W' : 'E') + String(Math.abs(lonBase)).padStart(3, '0')
  return `${la}${lo}`
}
const base3 = (v: number) => Math.floor(v / 3) * 3

interface Win { west: number; east: number; north: number; south: number; W: number; H: number; data: ArrayLike<number> }

export async function buildLandcover(regionId: string, onEvent: OnEvent, signal?: AbortSignal): Promise<boolean> {
  const region = getRegion(regionId)
  if (!region) throw new Error(`unknown region: ${regionId}`)
  if (!existsSync(pmtilesBin())) {
    onEvent({ phase: 'building_landcover', artifact: 'landcover', msg: 'Fetching pmtiles tool…' })
    try {
      await installPmtilesBin((m) => onEvent({ phase: 'building_landcover', artifact: 'landcover', msg: m }), signal)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      onEvent({ phase: 'building_landcover', artifact: 'landcover', msg: `Skipping — pmtiles tool unavailable (${String(err)})` })
      return false
    }
  }

  const dir = regionDir(regionId)
  await mkdir(dir, { recursive: true })
  const mbtilesPath = join(dir, 'landcover.mbtiles')
  const outPath = regionLandcoverPath(regionId)
  const cleanupTmp = async () => {
    for (const p of [mbtilesPath, `${mbtilesPath}-wal`, `${mbtilesPath}-shm`, `${mbtilesPath}-journal`]) await rm(p, { force: true }).catch(() => {})
  }
  await cleanupTmp()
  await rm(outPath, { force: true }).catch(() => {})

  // Lazily open each 3° COG once; null = missing (ocean / not produced).
  const cogCache = new Map<string, GeoTIFF | null>()
  const getCog = async (name: string): Promise<GeoTIFF | null> => {
    if (cogCache.has(name)) return cogCache.get(name)!
    let tiff: GeoTIFF | null = null
    try { tiff = await fromUrl(`${WORLDCOVER_BASE}/ESA_WorldCover_10m_2021_v200_${name}_Map.tif`) } catch { tiff = null }
    cogCache.set(name, tiff)
    return tiff
  }

  const tiles = tilesForBbox(region.bbox, LC_MIN_ZOOM, LC_MAX_ZOOM)
  const total = tiles.length
  onEvent({ phase: 'building_landcover', artifact: 'landcover', pct: 0, msg: `Sampling satellite landcover (${total} tiles)…` })

  const db = createMbtiles(mbtilesPath, {
    name: `${regionId} landcover`, format: 'png', type: 'baselayer', version: '1',
    minzoom: LC_MIN_ZOOM, maxzoom: LC_MAX_ZOOM, bounds: region.bbox.join(','),
  })
  const insert = db.prepare('INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)')

  let done = 0, written = 0, lastPct = -1
  db.exec('BEGIN')
  try {
    for (const t of tiles) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
      const n = 2 ** t.z
      const west = (t.x / n) * 360 - 180, east = ((t.x + 1) / n) * 360 - 180
      const north = mercY2lat(t.y / n), south = mercY2lat((t.y + 1) / n)

      // Read a window from each 3° COG intersecting this tile (usually 1).
      const wins: Win[] = []
      for (let lat = base3(south); lat < north; lat += 3) {
        for (let lon = base3(west); lon < east; lon += 3) {
          const tiff = await getCog(cogName(lat, lon))
          if (!tiff) continue
          const oW = Math.max(west, lon), oE = Math.min(east, lon + 3)
          const oN = Math.min(north, lat + 3), oS = Math.max(south, lat)
          if (oE <= oW || oN <= oS) continue
          const W = Math.max(1, Math.min(TILE, Math.round(((oE - oW) / (east - west)) * TILE)))
          const H = Math.max(1, Math.min(TILE, Math.round(((oN - oS) / (north - south)) * TILE)))
          const raster = await tiff.readRasters({ bbox: [oW, oS, oE, oN], width: W, height: H, resampleMethod: 'nearest' }) as unknown as ArrayLike<number>[]
          wins.push({ west: oW, east: oE, north: oN, south: oS, W, H, data: raster[0]! })
        }
      }

      const rgba = new Uint8Array(TILE * TILE * 4)
      let opaque = 0
      for (let py = 0; py < TILE; py++) {
        const lat = mercY2lat((t.y + (py + 0.5) / TILE) / n)
        for (let px = 0; px < TILE; px++) {
          const lon = west + ((px + 0.5) / TILE) * (east - west)
          const win = wins.find((w) => lon >= w.west && lon < w.east && lat <= w.north && lat > w.south)
          let cls = 0
          if (win) {
            const col = Math.min(win.W - 1, Math.floor(((lon - win.west) / (win.east - win.west)) * win.W))
            const row = Math.min(win.H - 1, Math.floor(((win.north - lat) / (win.north - win.south)) * win.H))
            cls = win.data[row * win.W + col]!
          }
          const c = COLORS[cls]
          const o = (py * TILE + px) * 4
          if (c) { rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255; opaque++ }
        }
      }

      if (opaque > 0) {
        const png = encodePngRGBA(TILE, TILE, rgba)
        const tmsY = 2 ** t.z - 1 - t.y
        insert.run(t.z, t.x, tmsY, png)
        if (++written % 2000 === 0) { db.exec('COMMIT'); db.exec('BEGIN') }
      }
      done++
      const pct = Math.floor((done / total) * 100)
      if (pct !== lastPct) { lastPct = pct; onEvent({ phase: 'building_landcover', artifact: 'landcover', pct, msg: `Landcover ${done}/${total} tiles` }) }
    }
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
    onEvent({ phase: 'building_landcover', artifact: 'landcover', msg: 'No landcover data for this region' })
    return false
  }

  onEvent({ phase: 'building_landcover', artifact: 'landcover', msg: 'Packing landcover into pmtiles…' })
  await runPmtilesConvert(mbtilesPath, outPath, signal)
  await cleanupTmp()
  return existsSync(outPath)
}
