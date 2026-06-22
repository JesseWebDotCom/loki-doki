// Region build pipeline — ported from v2 lokidoki/maps/build.py.
//
// For a selected region: download the OSM PBF (Geofabrik), then build three
// artifacts:
//   1. streets.pmtiles   — planetiler (Java)        → vector tiles
//   2. gh_cache/          — graphhopper import (Java) → routing graph
//   3. geocoder.sqlite    — osm-pbf-parser + FTS5     → place search index
//
// Steps 1–2 spawn the downloaded Java toolchain. Step 3 parses the PBF directly
// in-process with `osm-pbf-parser` (pure JS, bundled as a dependency — NO
// external binary; v2 used pyosmium) and streams named features into an SQLite
// FTS5 index. Fully self-contained: installs with the feature, no system deps.

import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import parseOSM from 'osm-pbf-parser'
import { getRegion } from '@/lib/maps/catalog'
import {
  graphhopperJar, javaBin, mapsSourcesDir, planetilerJar,
  regionGeocoderPath, regionGraphDir, regionPbfPath, regionTilesPath,
} from '@/lib/maps/paths'
import { invalidateGeocoderCache } from '@/lib/maps/geocoder'
import { ghImportConfigYaml } from '@/lib/maps/ghConfig'
import { buildTerrain } from '@/lib/maps/terrain'
import { buildLandcover } from '@/lib/maps/landcover'
import { measureRegionBytes, upsertRegionRow } from '@/lib/maps/store'

export type BuildPhase =
  | 'resolving' | 'downloading' | 'building_streets' | 'building_terrain'
  | 'building_landcover' | 'building_routing' | 'building_geocoder'
  | 'ready' | 'error' | 'cancelled'

export interface BuildEvent { phase: BuildPhase; artifact: string; pct?: number; msg?: string }
type OnEvent = (e: BuildEvent) => void

const BUILD_HEAP_MB = parseInt(process.env.LOKIDOKI_PLANETILER_HEAP_MB ?? '4096', 10)
const GH_BUILD_HEAP_MB = parseInt(process.env.LOKIDOKI_GRAPHHOPPER_HEAP_MB ?? '4096', 10)

function runJava(args: string[], onLine?: (line: string) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(javaBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const handle = (chunk: Buffer) => { const l = chunk.toString().trim(); if (l && onLine) onLine(l) }
    proc.stdout.on('data', handle)
    proc.stderr.on('data', handle)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`java exited ${code}`))))
    proc.on('error', reject)
    signal?.addEventListener('abort', () => { try { proc.kill('SIGTERM') } catch { /* gone */ }; reject(new DOMException('Cancelled', 'AbortError')) })
  })
}

async function downloadPbf(url: string, dest: string, onEvent: OnEvent, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`PBF download failed (${res.status})`)
  await mkdir(require_dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  const out = createWriteStream(tmp)
  const reader = res.body.getReader()
  const total = parseInt(res.headers.get('content-length') ?? '0', 10)
  let done = 0
  let lastPct = -1
  while (true) {
    if (signal?.aborted) { out.close(); throw new DOMException('Cancelled', 'AbortError') }
    const { done: finished, value } = await reader.read()
    if (finished) break
    out.write(Buffer.from(value))
    done += value.length
    if (total > 0) {
      const pct = Math.floor((done / total) * 100)
      if (pct !== lastPct) { lastPct = pct; onEvent({ phase: 'downloading', artifact: 'pbf', pct }) }
    }
  }
  await new Promise<void>((resolve, reject) => out.end((err: unknown) => (err ? reject(err) : resolve())))
  const { rename } = await import('node:fs/promises')
  await rename(tmp, dest)
}

function require_dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? '.' : p.slice(0, i)
}

// Throttle high-frequency subprocess log lines to ~1 event/sec so the SSE
// stream isn't flooded (planetiler/graphhopper emit many lines per second).
function makeLineThrottle(onEvent: OnEvent, phase: BuildPhase, artifact: string, intervalMs = 1000) {
  let last = 0
  return (line: string) => {
    const m = line.match(/(\d{1,3})%/)
    const now = Date.now()
    if (now - last < intervalMs && !m) return
    last = now
    onEvent({ phase, artifact, pct: m?.[1] ? parseInt(m[1], 10) : undefined, msg: line.slice(0, 140) })
  }
}

// ── Planetiler → streets.pmtiles ─────────────────────────────────────────────
async function buildStreets(regionId: string, onEvent: OnEvent, signal?: AbortSignal): Promise<void> {
  await mkdir(mapsSourcesDir, { recursive: true })
  const out = regionTilesPath(regionId)
  // First-ever build downloads ~1.4 GB of shared base-map data (Natural Earth +
  // water polygons) into tools/sources — surfaced so it doesn't look stalled.
  onEvent({ phase: 'building_streets', artifact: 'street', msg: 'Preparing base map data (one-time ~1.4 GB download on first build)…' })
  await runJava(
    [
      `-Xmx${BUILD_HEAP_MB}m`,
      '-jar', planetilerJar(),
      `--osm-path=${regionPbfPath(regionId)}`,
      `--download_dir=${mapsSourcesDir}`,
      `--output=${out}`,
      '--download',
      '--force',
    ],
    makeLineThrottle(onEvent, 'building_streets', 'street'),
    signal,
  )
}

// ── GraphHopper import → routing graph ───────────────────────────────────────
async function buildRouting(regionId: string, onEvent: OnEvent, signal?: AbortSignal): Promise<void> {
  onEvent({ phase: 'building_routing', artifact: 'valhalla', msg: 'Building routing graph…' })
  const graphDir = regionGraphDir(regionId)
  await mkdir(graphDir, { recursive: true })
  const configPath = `${graphDir}/import-config.yml`
  await writeFile(configPath, ghImportConfigYaml(regionPbfPath(regionId), graphDir))
  await runJava(
    [`-Xmx${GH_BUILD_HEAP_MB}m`, '-jar', graphhopperJar(), 'import', configPath],
    makeLineThrottle(onEvent, 'building_routing', 'valhalla'),
    signal,
  )
}

// ── osmium export → FTS5 geocoder ────────────────────────────────────────────
function osmiumAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('osmium', ['--version'], { stdio: 'ignore' })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

function createGeocoderSchema(db: Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS places USING fts5(
      region UNINDEXED, osm_id UNINDEXED, name, housenumber, street, city,
      postcode, admin1, phone, website, lat UNINDEXED, lon UNINDEXED,
      class UNINDEXED, opening_hours UNINDEXED, business_attrs UNINDEXED,
      brand_qid UNINDEXED, wiki_summary UNINDEXED, wiki_url UNINDEXED,
      tokenize = "unicode61 remove_diacritics 2"
    );
  `)
}

function classify(tags: Record<string, string>): string | null {
  if (tags.amenity) return `poi:${tags.amenity}`
  if (tags.shop) return `poi:${tags.shop}`
  if (tags.tourism) return `poi:${tags.tourism}`
  if (tags.leisure) return `poi:${tags.leisure}`
  if (tags.office) return `poi:${tags.office}`
  if (tags.place) return 'settlement'
  if (tags['addr:housenumber'] && tags['addr:street']) return 'address'
  if (tags.name) return 'poi:place'
  return null
}

interface OsmItem {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  refs?: number[]
  tags?: Record<string, string>
}

// Stream a .osm.pbf, invoking onItems for each decoded batch.
// NOTE: uses manual data forwarding instead of stream.pipe(parser) — Bun's native
// ReadStream.pipe() accesses dest._writableState before readable-stream v2 (used
// by osm-pbf-parser → stream-combiner2 → duplexer2) initialises it, producing
// "undefined is not an object (evaluating '_writableState.objectMode')" errors.
function streamPbf(path: string, onItems: (items: OsmItem[]) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path)
    const parser = parseOSM()
    const onAbort = () => { stream.destroy(); reject(new DOMException('Cancelled', 'AbortError')) }
    signal?.addEventListener('abort', onAbort)
    parser
      .on('data', (items: OsmItem[]) => { try { onItems(items) } catch (e) { stream.destroy(); reject(e) } })
      .on('end', () => { signal?.removeEventListener('abort', onAbort); resolve() })
      .on('error', reject)
    stream
      .on('data', (chunk: Buffer) => { parser.write(chunk) })
      .on('end', () => { parser.end() })
      .on('error', reject)
  })
}

// Build the FTS5 place-search index directly from the region PBF — no external
// binary (pyosmium/osmium in v2). Named NODES are indexed at their own
// coordinates; named WAYS (streets, buildings, parks) are indexed at a
// representative node so memory stays bounded (one cached node per way, not the
// whole node table).
async function buildGeocoder(regionId: string, onEvent: OnEvent, signal?: AbortSignal): Promise<boolean> {
  onEvent({ phase: 'building_geocoder', artifact: 'geocoder', msg: 'Indexing places…' })
  const pbf = regionPbfPath(regionId)
  const dbPath = regionGeocoderPath(regionId)
  await rm(dbPath, { force: true }).catch(() => {})
  const db = new Database(dbPath, { create: true })
  createGeocoderSchema(db)
  const insert = db.prepare(`
    INSERT INTO places (region, osm_id, name, housenumber, street, city, postcode,
      admin1, phone, website, lat, lon, class, opening_hours, business_attrs,
      brand_qid, wiki_summary, wiki_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `)
  const insertRow = (t: Record<string, string>, lat: number, lon: number, klass: string, osmId: number, kind: string) => {
    insert.run(
      regionId, `${kind}/${osmId}`,
      t.name ?? '',
      t['addr:housenumber'] ?? '',
      t['addr:street'] ?? '',
      t['addr:city'] ?? '',
      t['addr:postcode'] ?? '',
      t['addr:state'] ?? t['is_in:state'] ?? '',
      t.phone ?? t['contact:phone'] ?? '',
      t.website ?? t['contact:website'] ?? '',
      lat, lon, klass,
      t.opening_hours ?? '', null,
      t['brand:wikidata'] ?? '', null, null,
    )
  }

  // Pass 1: collect named/classifiable ways + one representative node id each.
  const wayBuf: { id: number; tags: Record<string, string>; ref: number }[] = []
  const neededNodes = new Set<number>()
  await streamPbf(pbf, (items) => {
    for (const it of items) {
      if (it.type !== 'way' || !it.tags || !it.refs?.length) continue
      if (!classify(it.tags)) continue
      const ref = it.refs[Math.floor(it.refs.length / 2)]!
      wayBuf.push({ id: it.id, tags: it.tags, ref })
      neededNodes.add(ref)
    }
  }, signal)

  // Pass 2: index named nodes inline; cache locations for the ways' rep nodes.
  const nodeLoc = new Map<number, [number, number]>()
  let count = 0
  db.exec('BEGIN')
  await streamPbf(pbf, (items) => {
    for (const it of items) {
      if (it.type !== 'node' || it.lat === undefined || it.lon === undefined) continue
      if (neededNodes.has(it.id)) nodeLoc.set(it.id, [it.lat, it.lon])
      if (!it.tags) continue
      const klass = classify(it.tags)
      if (!klass) continue
      insertRow(it.tags, it.lat, it.lon, klass, it.id, 'node')
      if (++count % 20000 === 0) {
        db.exec('COMMIT'); db.exec('BEGIN')
        onEvent({ phase: 'building_geocoder', artifact: 'geocoder', msg: `${count} places indexed` })
      }
    }
  }, signal)

  // Resolve buffered ways at their representative node.
  for (const w of wayBuf) {
    const loc = nodeLoc.get(w.ref)
    if (!loc) continue
    const klass = classify(w.tags)
    if (!klass) continue
    insertRow(w.tags, loc[0], loc[1], klass, w.id, 'way')
    count++
  }
  db.exec('COMMIT')
  db.close()
  onEvent({ phase: 'building_geocoder', artifact: 'geocoder', msg: `${count} places indexed` })
  return count > 0
}

// ── Orchestration ────────────────────────────────────────────────────────────

export async function buildRegion(regionId: string, onEvent: OnEvent, signal?: AbortSignal): Promise<void> {
  const region = getRegion(regionId)
  if (!region) throw new Error(`unknown region: ${regionId}`)
  if (!region.downloadable) throw new Error('parent regions are not installable')

  onEvent({ phase: 'resolving', artifact: 'pbf' })
  upsertRegionRow(regionId, { street: true, installStatus: 'building', phase: 'resolving', lastError: null })

  try {
    // 1. Download PBF
    if (!existsSync(regionPbfPath(regionId))) {
      await downloadPbf(region.pbfUrl, regionPbfPath(regionId), onEvent, signal)
    }
    upsertRegionRow(regionId, { pbfInstalled: true, phase: 'building_streets' })

    // 2. Streets (planetiler)
    await buildStreets(regionId, onEvent, signal)
    upsertRegionRow(regionId, { streetInstalled: true, phase: 'building_terrain' })

    // 2b. Terrain hillshade DEM (best-effort — a network hiccup here must not
    // fail an otherwise-good region; the map just renders without relief).
    let demInstalled = false
    try {
      demInstalled = await buildTerrain(regionId, onEvent, signal)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      onEvent({ phase: 'building_terrain', artifact: 'dem', msg: `Terrain skipped — ${String(err)}` })
    }
    upsertRegionRow(regionId, { demInstalled, phase: 'building_landcover' })

    // 2c. Satellite landcover wash (best-effort — ESA WorldCover via geotiff).
    let landcoverInstalled = false
    try {
      landcoverInstalled = await buildLandcover(regionId, onEvent, signal)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      onEvent({ phase: 'building_landcover', artifact: 'landcover', msg: `Landcover skipped — ${String(err)}` })
    }
    upsertRegionRow(regionId, { landcoverInstalled, phase: 'building_routing' })

    // 3. Routing (graphhopper)
    await buildRouting(regionId, onEvent, signal)
    upsertRegionRow(regionId, { valhallaInstalled: true, phase: 'building_geocoder' })

    // 4. Geocoder (osmium → FTS5, best-effort)
    let geo = false
    try {
      geo = await buildGeocoder(regionId, onEvent, signal)
      invalidateGeocoderCache(regionId)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      onEvent({ phase: 'building_geocoder', artifact: 'geocoder', msg: `Geocoder skipped — ${String(err)}` })
    }

    // Drop the raw PBF unless asked to keep it (saves a lot of disk).
    if (process.env.LOKIDOKI_KEEP_PBF !== '1') {
      await rm(regionPbfPath(regionId), { force: true }).catch(() => {})
    }

    upsertRegionRow(regionId, {
      geocoderInstalled: geo,
      pbfInstalled: process.env.LOKIDOKI_KEEP_PBF === '1',
      installStatus: 'ready',
      phase: 'ready',
      installedAt: new Date(),
      bytesOnDisk: JSON.stringify(measureRegionBytes(regionId)),
    })
    onEvent({ phase: 'ready', artifact: 'done' })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      upsertRegionRow(regionId, { installStatus: 'cancelled', phase: null })
      onEvent({ phase: 'cancelled', artifact: 'cancelled' })
      throw err
    }
    upsertRegionRow(regionId, { installStatus: 'error', phase: null, lastError: String(err) })
    onEvent({ phase: 'error', artifact: 'error', msg: String(err) })
    throw err
  }
}

// Rebuild only the geocoder index for an installed region (schema upgrades).
export async function reindexRegion(regionId: string, onEvent: OnEvent, signal?: AbortSignal): Promise<void> {
  if (!existsSync(regionPbfPath(regionId))) {
    throw new Error('reindex needs the raw PBF; re-install the region with LOKIDOKI_KEEP_PBF=1')
  }
  upsertRegionRow(regionId, { phase: 'building_geocoder' })
  const geo = await buildGeocoder(regionId, onEvent, signal)
  invalidateGeocoderCache(regionId)
  upsertRegionRow(regionId, {
    geocoderInstalled: geo, phase: 'ready', geocoderSchemaVersion: 2,
    bytesOnDisk: JSON.stringify(measureRegionBytes(regionId)),
  })
}
