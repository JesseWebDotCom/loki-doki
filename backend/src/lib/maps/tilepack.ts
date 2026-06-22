// Shared helpers for baking raster tile pyramids into a .pmtiles archive:
// slippy-tile maths, a minimal MBTiles writer, the go-pmtiles convert step, and
// a tiny dependency-free PNG (RGBA) encoder. Used by the landcover bake; the
// terrain (DEM) bake predates this and keeps its own inline copies.

import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { pmtilesBin } from '@/lib/maps/paths'

export const MAX_MERC_LAT = 85.05112878

export function lon2tile(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z)
}
export function lat2tile(lat: number, z: number): number {
  const r = (Math.min(MAX_MERC_LAT, Math.max(-MAX_MERC_LAT, lat)) * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}
// Inverse: web-mercator tile-Y fraction (0..1) → latitude.
export function mercY2lat(yFrac: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * yFrac))) * 180) / Math.PI
}

export function tilesForBbox(
  bbox: [number, number, number, number], minZoom: number, maxZoom: number,
): { z: number; x: number; y: number }[] {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const out: { z: number; x: number; y: number }[] = []
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z
    const clamp = (v: number) => Math.max(0, Math.min(n - 1, v))
    const x0 = clamp(lon2tile(minLon, z)), x1 = clamp(lon2tile(maxLon, z))
    const y0 = clamp(lat2tile(maxLat, z)), y1 = clamp(lat2tile(minLat, z))
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y })
  }
  return out
}

// ── Minimal MBTiles (go-pmtiles convert turns it into .pmtiles) ──────────────
export function createMbtiles(path: string, meta: Record<string, string | number>): Database {
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

export function runPmtilesConvert(input: string, output: string, signal?: AbortSignal): Promise<void> {
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

// ── Dependency-free PNG encoder (8-bit RGBA, no row filtering) ────────────────
// sharp is unavailable/broken in this environment, so flat landcover tiles are
// encoded by hand. Solid-colour tiles deflate to almost nothing and go-pmtiles
// then de-duplicates identical tiles, keeping the archive tiny.
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return t
})()
function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (~c) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
export function encodePngRGBA(width: number, height: number, rgba: Uint8Array): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0 // 8-bit, RGBA, no compression/filter/interlace
  const stride = width * 4
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter byte: None
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}
