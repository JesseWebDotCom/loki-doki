// Maps toolchain installer — downloads the offline build/runtime tools:
//   • Temurin JRE 21      (runs planetiler + graphhopper)
//   • Planetiler 0.8.4    (OSM PBF → streets.pmtiles vector tiles)
//   • GraphHopper 10.1    (OSM PBF → routing graph + runtime server)
//   • go-pmtiles 1.30.3   (pmtiles archive utility)
//   • Font glyph PBFs     (MapLibre label rendering)
//
// Mirrors v2 lokidoki/bootstrap/maps_tools.py. Tools land under
// data/maps/tools/. Everything is downloaded at runtime via the admin
// Features → Maps install flow (same pattern as kiwix / voice / sd.cpp), never
// bundled. Progress is reported as status strings; downloads go through the
// shared resumable downloader (retry + .part resume + verification).

import { spawn } from 'node:child_process'
import { extractZip, killByCommandLine } from '@/lib/platform'
import { downloadUrl } from '@/lib/download'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  graphhopperJar, javaBin, mapsGlyphsDir, mapsOverviewDir, mapsSourcesDir,
  mapsToolsDir, overviewPmtilesPath, planetilerJar, pmtilesBin,
  worldCountriesPath, worldLabelsPath, worldStatesPath,
} from '@/lib/maps/paths'

type OnStatus = (msg: string) => void

const PLANETILER_VERSION = '0.8.4'
const GRAPHHOPPER_VERSION = '10.1'
const PMTILES_VERSION = '1.30.3'
const JRE_VERSION = '21.0.5+11'
const JRE_VERSION_ENC = encodeURIComponent('jdk-21.0.5+11')

// JRE and go-pmtiles use DIFFERENT archive conventions per OS, so their
// extensions are tracked separately. In particular go-pmtiles' macOS asset is
// `go-pmtiles-<ver>_Darwin_<arch>.zip` (HYPHEN before the version, .zip),
// whereas its Linux asset is `go-pmtiles_<ver>_Linux_<arch>.tar.gz` (underscore,
// .tar.gz) — a goreleaser quirk. Getting the macOS name wrong 404s and the
// best-effort installer silently skips pmtiles (which breaks terrain builds).
function platformKey(): { jre: string; jreExt: string; pmtiles: string; pmtilesExt: string } {
  const arm = process.arch === 'arm64'
  if (process.platform === 'darwin') {
    return {
      jre: `OpenJDK21U-jre_${arm ? 'aarch64' : 'x64'}_mac_hotspot_21.0.5_11.tar.gz`,
      jreExt: 'tar.gz',
      pmtiles: `go-pmtiles-${PMTILES_VERSION}_Darwin_${arm ? 'arm64' : 'x86_64'}.zip`,
      pmtilesExt: 'zip',
    }
  }
  if (process.platform === 'win32') {
    return {
      jre: `OpenJDK21U-jre_x64_windows_hotspot_21.0.5_11.zip`,
      jreExt: 'zip',
      pmtiles: `go-pmtiles_${PMTILES_VERSION}_Windows_${arm ? 'arm64' : 'x86_64'}.zip`,
      pmtilesExt: 'zip',
    }
  }
  return {
    jre: `OpenJDK21U-jre_${arm ? 'aarch64' : 'x64'}_linux_hotspot_21.0.5_11.tar.gz`,
    jreExt: 'tar.gz',
    pmtiles: `go-pmtiles_${PMTILES_VERSION}_Linux_${arm ? 'arm64' : 'x86_64'}.tar.gz`,
    pmtilesExt: 'tar.gz',
  }
}

// Thin adapter over the shared resumable downloader (lib/download.ts): brings
// retry with backoff, .part resume, stall detection, and size/checksum verification
// to the toolchain downloads, which were previously one-shot fetches that a single
// network blip forced back to byte zero.
async function fetchToFile(url: string, dest: string, onStatus: OnStatus, signal?: AbortSignal, expectedSha256?: string): Promise<void> {
  const name = url.split('/').pop()
  onStatus(`Downloading ${name}…`)
  let lastPct = -1
  await downloadUrl(url, dest, (p) => {
    if (p.status) { onStatus(`${name}: ${p.status}`); return }
    if (p.total > 0) {
      const pct = Math.floor((p.completed / p.total) * 100)
      if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; onStatus(`${name}: ${pct}%`) }
    }
  }, signal, { expectedSha256 })
}

// Adoptium publishes `<asset>.sha256.txt` ("<hex>  <filename>") next to every JRE
// asset. Best-effort: if unreachable, install proceeds unverified.
async function adoptiumSha256(assetUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${assetUrl}.sha256.txt`, { redirect: 'follow', signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return undefined
    const hex = (await res.text()).trim().split(/\s+/)[0]
    return /^[a-f0-9]{64}$/i.test(hex ?? '') ? hex : undefined
  } catch { return undefined }
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: 'ignore' })
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
    proc.on('error', reject)
  })
}

async function extract(archive: string, destDir: string, ext: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  // Windows zips (JRE + pmtiles) go through PowerShell; tar.gz only happens on macOS/Linux.
  if (ext === 'zip') await extractZip(archive, destDir)
  else await run('tar', ['-xzf', archive, '-C', destDir], destDir)
}

// Run java (planetiler), surfacing throttled progress lines as status text.
function runJavaStreaming(args: string[], onStatus: OnStatus, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(javaBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let last = 0
    const handle = (chunk: Buffer) => {
      const line = chunk.toString().trim()
      if (!line) return
      const m = line.match(/(\d{1,3})%/)
      const now = Date.now()
      if (now - last < 1500 && !m) return
      last = now
      onStatus(line.slice(0, 140))
    }
    proc.stdout.on('data', handle)
    proc.stderr.on('data', handle)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`planetiler exited ${code}`))))
    proc.on('error', reject)
    signal?.addEventListener('abort', () => {
      try { proc.kill('SIGTERM') } catch { /* gone */ }
      reject(new DOMException('Cancelled', 'AbortError'))
    })
  })
}

// Build the low-detail world overview basemap (maxzoom 7) — ported from v2
// ensure_world_overview. planetiler needs an OSM input, so a tiny seed PBF
// (Monaco) is used; the global low-zoom content (countries, coastlines, water)
// comes from Natural Earth + water polygons, which planetiler downloads. The
// output is served at /api/maps/tiles/_overview/streets.pmtiles and is what the
// map shows when zoomed out or outside any installed region.
const OVERVIEW_HEAP_MB = parseInt(process.env.LOKIDOKI_WORLD_OVERVIEW_HEAP_MB ?? '2048', 10)
const SEED_PBF_URL = 'https://download.geofabrik.de/europe/monaco-latest.osm.pbf'

let overviewBuilding = false

const overviewLockPath = () => join(mapsOverviewDir, '.building.pid')

// Build the overview in the background if the toolchain is installed but the
// overview is missing (e.g. toolchain was installed before overview support, or
// a prior build was interrupted). Called at boot; safe to call repeatedly.
export async function maybeBuildWorldOverview(): Promise<void> {
  if (overviewBuilding) return
  if (!isMapsToolchainInstalled()) return
  if (existsSync(overviewPmtilesPath())) return

  // Kill any orphaned overview build from a previous server instance.
  const lockPath = overviewLockPath()
  if (existsSync(lockPath)) {
    await killByCommandLine('monaco.osm.pbf')
    rmSync(lockPath, { force: true })
  }

  overviewBuilding = true
  try {
    await mkdir(mapsOverviewDir, { recursive: true })
    writeFileSync(lockPath, String(process.pid))
    const { logger } = await import('@/lib/logger')
    await buildWorldOverview((msg) => logger.info({ msg }, '[maps] world overview'))
  } catch (err) {
    const { logger } = await import('@/lib/logger')
    logger.warn({ err: String(err) }, '[maps] world overview build failed')
  } finally {
    overviewBuilding = false
    rmSync(lockPath, { force: true })
  }
}

async function buildWorldOverview(onStatus: OnStatus, signal?: AbortSignal): Promise<void> {
  if (existsSync(overviewPmtilesPath())) { onStatus('World overview already built'); return }
  await mkdir(mapsOverviewDir, { recursive: true })
  await mkdir(mapsSourcesDir, { recursive: true })
  const seed = join(mapsSourcesDir, 'monaco.osm.pbf')
  if (!existsSync(seed)) await fetchToFile(SEED_PBF_URL, seed, onStatus, signal)
  onStatus('Building world overview map (one-time, a few minutes)…')
  await runJavaStreaming(
    [
      `-Xmx${OVERVIEW_HEAP_MB}m`,
      '-jar', planetilerJar(),
      `--osm-path=${seed}`,
      `--download_dir=${mapsSourcesDir}`,
      `--output=${overviewPmtilesPath()}`,
      '--download',
      '--maxzoom=7',
      '--bounds=-180,-85,180,85',
      '--force',
    ],
    onStatus,
    signal,
  )
  // Planetiler downloaded natural_earth_vector.sqlite.zip; use it now.
  await buildWorldGeoJSON(onStatus)
}

// ── World overview GeoJSON (country/state fills + overview labels) ───────────
// Reads the Natural Earth SQLite that planetiler downloads, parses the WKB
// polygon/point geometries, and writes three FeatureCollection files:
//   world-countries.geojson — polygons with mapcolor7 (country fills)
//   world-states.geojson    — polygons with mapcolor9 (state fills)
//   world-labels.geojson    — points with kind/name/area_log/min_zoom

const NE_ZIP_ENTRY = 'natural_earth_vector.sqlite/packages/natural_earth_vector.sqlite'
function neZipPath(): string { return join(mapsSourcesDir, 'natural_earth_vector.sqlite.zip') }

export async function maybeBuildWorldGeoJSON(): Promise<void> {
  if (!existsSync(neZipPath())) return
  if (existsSync(worldCountriesPath()) && existsSync(worldStatesPath()) && existsSync(worldLabelsPath())) return
  const { logger } = await import('@/lib/logger')
  try {
    await buildWorldGeoJSON((msg) => logger.info({ msg }, '[maps] world geojson'))
  } catch (err) {
    logger.warn({ err: String(err) }, '[maps] world geojson build failed')
  }
}

async function buildWorldGeoJSON(onStatus: OnStatus): Promise<void> {
  const tmpDir = join(mapsToolsDir, '_ne_tmp')
  try {
    onStatus('Extracting Natural Earth database…')
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    await mkdir(tmpDir, { recursive: true })
    // Extract the whole archive (cross-platform) then read the sqlite at its entry path.
    // The NE zip is essentially just this one database, so a full extract costs nothing extra.
    await extractZip(neZipPath(), tmpDir)
    const tmpDb = join(tmpDir, NE_ZIP_ENTRY)

    onStatus('Generating world overview GeoJSON…')
    const { Database } = await import('bun:sqlite')
    const db = new Database(tmpDb, { readonly: true })

    const countryFeatures = db
      .query<{ GEOMETRY: Uint8Array; mapcolor7: number }, []>(
        'SELECT GEOMETRY, mapcolor7 FROM ne_50m_admin_0_countries_lakes WHERE GEOMETRY IS NOT NULL',
      )
      .all()
      .map((row) => {
        const parsed = parseWKB(row.GEOMETRY)
        return parsed ? { type: 'Feature', geometry: wkbToGeoJSON(parsed), properties: { mapcolor7: row.mapcolor7 ?? 1 } } : null
      })
      .filter(Boolean)

    const stateFeatures = db
      .query<{ GEOMETRY: Uint8Array; mapcolor9: number }, []>(
        'SELECT GEOMETRY, mapcolor9 FROM ne_50m_admin_1_states_provinces_lakes WHERE GEOMETRY IS NOT NULL',
      )
      .all()
      .map((row) => {
        const parsed = parseWKB(row.GEOMETRY)
        return parsed ? { type: 'Feature', geometry: wkbToGeoJSON(parsed), properties: { mapcolor9: row.mapcolor9 ?? 1 } } : null
      })
      .filter(Boolean)

    const labelFeatures: object[] = []

    for (const row of db
      .query<{ GEOMETRY: Uint8Array; name: string }, []>(
        "SELECT GEOMETRY, name FROM ne_50m_admin_0_countries_lakes WHERE GEOMETRY IS NOT NULL AND name IS NOT NULL",
      )
      .all()) {
      const parsed = parseWKB(row.GEOMETRY)
      if (!parsed) continue
      labelFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: reprPoint(parsed) },
        properties: { kind: 'country', name: row.name, area_log: areaLog(parsed) },
      })
    }

    for (const row of db
      .query<{ GEOMETRY: Uint8Array; name: string }, []>(
        "SELECT GEOMETRY, name FROM ne_50m_admin_1_states_provinces_lakes WHERE GEOMETRY IS NOT NULL AND name IS NOT NULL",
      )
      .all()) {
      const parsed = parseWKB(row.GEOMETRY)
      if (!parsed) continue
      labelFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: reprPoint(parsed) },
        properties: { kind: 'state', name: row.name, area_log: areaLog(parsed) },
      })
    }

    for (const row of db
      .query<{ GEOMETRY: Uint8Array; name: string; featurecla: string; min_label: number }, []>(
        "SELECT GEOMETRY, name, featurecla, min_label FROM ne_10m_geography_marine_polys WHERE GEOMETRY IS NOT NULL AND name IS NOT NULL AND name != ''",
      )
      .all()) {
      const parsed = parseWKB(row.GEOMETRY)
      if (!parsed) continue
      const fc = (row.featurecla ?? '').toLowerCase()
      const kind = fc.includes('ocean') ? 'ocean' : 'sea'
      const name = row.name === row.name.toUpperCase() ? row.name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : row.name
      labelFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: reprPoint(parsed) },
        properties: { kind, name, area_log: areaLog(parsed), min_zoom: row.min_label ?? 1 },
      })
    }

    for (const row of db
      .query<{ GEOMETRY: Uint8Array; name: string }, []>(
        "SELECT GEOMETRY, name FROM ne_50m_lakes WHERE GEOMETRY IS NOT NULL AND name IS NOT NULL AND name != ''",
      )
      .all()) {
      const parsed = parseWKB(row.GEOMETRY)
      if (!parsed) continue
      labelFeatures.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: reprPoint(parsed) },
        properties: { kind: 'lake', name: row.name, area_log: areaLog(parsed) },
      })
    }

    db.close()
    await mkdir(mapsOverviewDir, { recursive: true })
    writeFileSync(worldCountriesPath(), JSON.stringify({ type: 'FeatureCollection', features: countryFeatures }))
    writeFileSync(worldStatesPath(), JSON.stringify({ type: 'FeatureCollection', features: stateFeatures }))
    writeFileSync(worldLabelsPath(), JSON.stringify({ type: 'FeatureCollection', features: labelFeatures }))
    onStatus('World overview GeoJSON built')
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── Minimal WKB parser (Point / Polygon / MultiPolygon) ──────────────────────

type WKBParsed =
  | { type: 'Point'; x: number; y: number }
  | { type: 'Polygon'; rings: [number, number][][] }
  | { type: 'MultiPolygon'; polygons: [number, number][][][] }

function parseWKB(blob: Uint8Array): WKBParsed | null {
  try {
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
    let pos = 0
    const le = view.getUint8(pos++) === 1
    const readU32 = () => { const v = view.getUint32(pos, le); pos += 4; return v }
    const readF64 = () => { const v = view.getFloat64(pos, le); pos += 8; return v }
    const readRing = (): [number, number][] => {
      const n = readU32()
      const ring: [number, number][] = []
      for (let i = 0; i < n; i++) ring.push([readF64(), readF64()])
      return ring
    }
    const type = readU32()
    if (type === 1) return { type: 'Point', x: readF64(), y: readF64() }
    if (type === 3) {
      const numRings = readU32()
      const rings: [number, number][][] = []
      for (let i = 0; i < numRings; i++) rings.push(readRing())
      return { type: 'Polygon', rings }
    }
    if (type === 6) {
      const numPolys = readU32()
      const polygons: [number, number][][][] = []
      for (let i = 0; i < numPolys; i++) {
        pos += 1 // skip byteOrder of sub-polygon
        readU32() // skip type (3 = Polygon)
        const numRings = readU32()
        const rings: [number, number][][] = []
        for (let r = 0; r < numRings; r++) rings.push(readRing())
        polygons.push(rings)
      }
      return { type: 'MultiPolygon', polygons }
    }
    return null
  } catch { return null }
}

function wkbToGeoJSON(p: WKBParsed): object {
  const r4 = (v: number) => Math.round(v * 10000) / 10000
  if (p.type === 'Point') return { type: 'Point', coordinates: [r4(p.x), r4(p.y)] }
  if (p.type === 'Polygon') return { type: 'Polygon', coordinates: p.rings.map(ring => ring.map(([x, y]) => [r4(x), r4(y)])) }
  return { type: 'MultiPolygon', coordinates: p.polygons.map(poly => poly.map(ring => ring.map(([x, y]) => [r4(x), r4(y)]))) }
}

function reprPoint(p: WKBParsed): [number, number] {
  const r4 = (v: number) => Math.round(v * 10000) / 10000
  if (p.type === 'Point') return [r4(p.x), r4(p.y)]
  const outerRings: [number, number][][] =
    p.type === 'Polygon'
      ? (p.rings[0] ? [p.rings[0]] : [])
      : p.polygons.map(poly => poly[0]).filter((r): r is [number, number][] => r !== undefined)
  let best: [number, number][] = outerRings[0] ?? []
  let bestArea = -1
  for (const ring of outerRings) {
    let a = 0
    for (let i = 0; i < ring.length - 1; i++) a += (ring[i]?.[0] ?? 0) * (ring[i + 1]?.[1] ?? 0) - (ring[i + 1]?.[0] ?? 0) * (ring[i]?.[1] ?? 0)
    if (Math.abs(a) > bestArea) { bestArea = Math.abs(a); best = ring }
  }
  let sx = 0, sy = 0
  for (const [x, y] of best) { sx += x; sy += y }
  const n = best.length || 1
  return [r4(sx / n), r4(sy / n)]
}

function areaLog(p: WKBParsed): number {
  const outers: [number, number][][] =
    p.type === 'Polygon'
      ? (p.rings[0] ? [p.rings[0]] : [])
      : p.type === 'MultiPolygon'
        ? p.polygons.map(poly => poly[0]).filter((r): r is [number, number][] => r !== undefined)
        : []
  let totalArea = 0, sumY = 0, numY = 0
  for (const ring of outers) {
    let a = 0
    for (let i = 0; i < ring.length - 1; i++) {
      a += (ring[i]?.[0] ?? 0) * (ring[i + 1]?.[1] ?? 0) - (ring[i + 1]?.[0] ?? 0) * (ring[i]?.[1] ?? 0)
      sumY += ring[i]?.[1] ?? 0; numY++
    }
    totalArea += Math.abs(a) / 2
  }
  if (totalArea === 0 || numY === 0) return 0
  const cosLat = Math.max(Math.cos(sumY / numY * Math.PI / 180), 0.01)
  return Math.round(Math.log10(Math.max(totalArea * cosLat, 0.0001)) * 1000) / 1000
}

export function isMapsToolchainInstalled(): boolean {
  return existsSync(javaBin()) && existsSync(planetilerJar()) && existsSync(graphhopperJar())
}

// Install just the go-pmtiles binary (packs DEM tiles → dem.pmtiles for the
// terrain/hillshade layer). Split out so a terrain build can self-heal when the
// binary is absent — it downloads best-effort during the main toolchain install
// and older installs (or a wrong-asset 404) may lack it. No-op if present;
// throws on failure so callers can decide whether to skip.
export async function installPmtilesBin(onStatus: OnStatus, signal?: AbortSignal): Promise<void> {
  if (existsSync(pmtilesBin())) return
  await mkdir(mapsToolsDir, { recursive: true })
  const plat = platformKey()
  const url = `https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/${plat.pmtiles}`
  const archive = join(mapsToolsDir, `pmtiles.${plat.pmtilesExt}`)
  await fetchToFile(url, archive, onStatus, signal)
  await extract(archive, mapsToolsDir, plat.pmtilesExt)
  await rm(archive, { force: true }).catch(() => {})
  if (process.platform !== 'win32') await chmod(pmtilesBin(), 0o755).catch(() => {})
  if (!existsSync(pmtilesBin())) throw new Error('pmtiles binary missing after extract')
}

export async function installMapsToolchain(onStatus: OnStatus, signal?: AbortSignal): Promise<void> {
  await mkdir(mapsToolsDir, { recursive: true })
  const plat = platformKey()

  // ── Temurin JRE ──────────────────────────────────────────────────────────
  if (!existsSync(javaBin())) {
    const jreUrl = `https://github.com/adoptium/temurin21-binaries/releases/download/${JRE_VERSION_ENC}/${plat.jre}`
    const jreArchive = join(mapsToolsDir, `jre.${plat.jreExt}`)
    await fetchToFile(jreUrl, jreArchive, onStatus, signal, await adoptiumSha256(jreUrl))
    onStatus('Extracting Java runtime…')
    const jreStage = join(mapsToolsDir, 'jre-stage')
    await rm(jreStage, { recursive: true, force: true }).catch(() => {})
    await extract(jreArchive, jreStage, plat.jreExt)
    // The archive contains a single top-level dir (jdk-21.0.5+11-jre); move it to tools/jre.
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(jreStage)
    const top = entries[0]
    if (!top) throw new Error('JRE archive was empty')
    await rm(join(mapsToolsDir, 'jre'), { recursive: true, force: true }).catch(() => {})
    await rename(join(jreStage, top), join(mapsToolsDir, 'jre'))
    await rm(jreStage, { recursive: true, force: true }).catch(() => {})
    await rm(jreArchive, { force: true }).catch(() => {})
    if (process.platform !== 'win32') await chmod(javaBin(), 0o755).catch(() => {})
  } else {
    onStatus('Java runtime already installed')
  }

  // ── Planetiler ───────────────────────────────────────────────────────────
  if (!existsSync(planetilerJar())) {
    const url = `https://github.com/onthegomap/planetiler/releases/download/v${PLANETILER_VERSION}/planetiler.jar`
    await fetchToFile(url, planetilerJar(), onStatus, signal)
  } else {
    onStatus('Planetiler already installed')
  }

  // ── GraphHopper ──────────────────────────────────────────────────────────
  if (!existsSync(graphhopperJar())) {
    const url = `https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/${GRAPHHOPPER_VERSION}/graphhopper-web-${GRAPHHOPPER_VERSION}.jar`
    await fetchToFile(url, graphhopperJar(), onStatus, signal)
  } else {
    onStatus('GraphHopper already installed')
  }

  // ── go-pmtiles utility ───────────────────────────────────────────────────
  // Best-effort here so a pmtiles hiccup doesn't fail the whole toolchain — but
  // it IS required for terrain/hillshade, so buildTerrain self-heals by calling
  // installPmtilesBin() again if this was skipped.
  try {
    await installPmtilesBin(onStatus, signal)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    onStatus(`pmtiles utility optional — skipped (${String(err)})`)
  }

  // ── Font glyphs (best-effort) ────────────────────────────────────────────
  if (!existsSync(join(mapsGlyphsDir, 'Noto Sans Regular'))) {
    try {
      onStatus('Downloading map font glyphs…')
      const url = 'https://github.com/protomaps/basemaps-assets/archive/refs/heads/main.tar.gz'
      const archive = join(mapsToolsDir, 'assets.tar.gz')
      await fetchToFile(url, archive, onStatus, signal)
      const stage = join(mapsToolsDir, 'assets-stage')
      await rm(stage, { recursive: true, force: true }).catch(() => {})
      await extract(archive, stage, 'tar.gz')
      const { readdir, cp } = await import('node:fs/promises')
      const top = (await readdir(stage))[0]
      const fontsSrc = top ? join(stage, top, 'fonts') : ''
      if (fontsSrc && existsSync(fontsSrc)) {
        await mkdir(mapsGlyphsDir, { recursive: true })
        await cp(fontsSrc, mapsGlyphsDir, { recursive: true })
      }
      await rm(stage, { recursive: true, force: true }).catch(() => {})
      await rm(archive, { force: true }).catch(() => {})
    } catch (err) {
      onStatus(`Font glyphs optional — skipped (${String(err)})`)
    }
  }

  if (!isMapsToolchainInstalled()) {
    throw new Error('Maps toolchain incomplete after install — check network access.')
  }

  // ── World overview basemap (best-effort) ─────────────────────────────────
  // Built after the jars are confirmed present. Failure here doesn't fail the
  // toolchain — regions still build/route; only the zoomed-out basemap is lost.
  try {
    await buildWorldOverview(onStatus, signal)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    onStatus(`World overview optional — skipped (${String(err)})`)
  }

  onStatus('Maps toolchain installed')
}
