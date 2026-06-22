import { join } from 'node:path'
import { dataDir } from '@/lib/download'

// All offline-map data lives under data/maps/.
//   data/maps/tools/           — downloaded toolchain (JRE, planetiler, graphhopper, pmtiles)
//   data/maps/tools/sources/   — shared planetiler sources (natural earth, water polygons)
//   data/maps/tools/glyphs/    — font glyph PBFs for label rendering
//   data/maps/_overview/       — world overview tiles + country/state geojson
//   data/maps/<regionId>/      — per-region streets.pmtiles, gh_cache/, geocoder.sqlite
export const mapsDir       = join(dataDir, 'maps')
export const mapsToolsDir  = join(mapsDir, 'tools')
export const mapsSourcesDir = join(mapsToolsDir, 'sources')
export const mapsGlyphsDir = join(mapsToolsDir, 'glyphs')
export const mapsOverviewDir = join(mapsDir, '_overview')

export function regionDir(regionId: string): string {
  return join(mapsDir, regionId)
}
export function regionTilesPath(regionId: string): string {
  return join(regionDir(regionId), 'streets.pmtiles')
}
export function regionDemPath(regionId: string): string {
  return join(regionDir(regionId), 'dem.pmtiles')
}
export function regionLandcoverPath(regionId: string): string {
  return join(regionDir(regionId), 'landcover.pmtiles')
}
export function regionGraphDir(regionId: string): string {
  return join(regionDir(regionId), 'gh_cache')
}
export function regionGeocoderPath(regionId: string): string {
  return join(regionDir(regionId), 'geocoder.sqlite')
}
export function regionPbfPath(regionId: string): string {
  return join(regionDir(regionId), 'region.osm.pbf')
}

// Toolchain artifact locations.
export function javaBin(): string {
  const sub = process.platform === 'darwin' ? 'Contents/Home/bin/java' : 'bin/java'
  return join(mapsToolsDir, 'jre', sub)
}
export function planetilerJar(): string { return join(mapsToolsDir, 'planetiler.jar') }
export function graphhopperJar(): string { return join(mapsToolsDir, 'graphhopper.jar') }
export function pmtilesBin(): string {
  return join(mapsToolsDir, process.platform === 'win32' ? 'pmtiles.exe' : 'pmtiles')
}
export function overviewPmtilesPath(): string { return join(mapsOverviewDir, 'streets.pmtiles') }
export function worldCountriesPath(): string { return join(mapsOverviewDir, 'world-countries.geojson') }
export function worldStatesPath(): string { return join(mapsOverviewDir, 'world-states.geojson') }
export function worldLabelsPath(): string { return join(mapsOverviewDir, 'world-labels.geojson') }
