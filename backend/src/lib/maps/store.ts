// Region install-state store. Backed by the `map_regions` table; mirrors the
// JSON state files from v2 (lokidoki/maps/store.py) but persisted in SQLite.

import { rm } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { mapRegions } from '@/db/schema'
import { getRegion } from '@/lib/maps/catalog'
import { regionDir } from '@/lib/maps/paths'

export interface RegionStateRow {
  regionId: string
  street: boolean
  installStatus: string
  phase: string | null
  streetInstalled: boolean
  demInstalled: boolean
  landcoverInstalled: boolean
  valhallaInstalled: boolean
  pbfInstalled: boolean
  geocoderInstalled: boolean
  openaddressesInstalled: boolean
  geocoderSchemaVersion: number
  bytesOnDisk: Record<string, number>
  lastError: string | null
  installedAt: Date | null
}

function rowToState(r: typeof mapRegions.$inferSelect): RegionStateRow {
  let bytesOnDisk: Record<string, number> = {}
  try { bytesOnDisk = JSON.parse(r.bytesOnDisk) } catch { /* ignore */ }
  return {
    regionId: r.regionId,
    street: r.street,
    installStatus: r.installStatus,
    phase: r.phase,
    streetInstalled: r.streetInstalled,
    demInstalled: r.demInstalled,
    landcoverInstalled: r.landcoverInstalled,
    valhallaInstalled: r.valhallaInstalled,
    pbfInstalled: r.pbfInstalled,
    geocoderInstalled: r.geocoderInstalled,
    openaddressesInstalled: r.openaddressesInstalled,
    geocoderSchemaVersion: r.geocoderSchemaVersion,
    bytesOnDisk,
    lastError: r.lastError,
    installedAt: r.installedAt,
  }
}

export function listInstalledRegions(): RegionStateRow[] {
  return db.select().from(mapRegions).all().map(rowToState)
}

export function getRegionState(regionId: string): RegionStateRow | null {
  const r = db.select().from(mapRegions).where(eq(mapRegions.regionId, regionId)).get()
  return r ? rowToState(r) : null
}

// Shape consumed by GET /api/maps/regions and the frontend useInstalledMapRegions.
export function listRegionsForApi() {
  return listInstalledRegions().map((s) => {
    const region = getRegion(s.regionId)
    return {
      region_id: s.regionId,
      label: region?.label ?? s.regionId,
      config: { region_id: s.regionId, street: s.street },
      state: {
        region_id: s.regionId,
        street_installed: s.streetInstalled,
        dem_installed: s.demInstalled,
        landcover_installed: s.landcoverInstalled,
        valhalla_installed: s.valhallaInstalled,
        pbf_installed: s.pbfInstalled,
        geocoder_installed: s.geocoderInstalled,
        openaddresses_installed: s.openaddressesInstalled,
        bytes_on_disk: s.bytesOnDisk,
        installed_at: s.installedAt ? s.installedAt.toISOString() : null,
        geocoder_schema_version: s.geocoderSchemaVersion,
        last_error: s.lastError,
      },
      bbox: region ? region.bbox : [0, 0, 0, 0],
      center: region ? region.center : { lat: 0, lon: 0 },
    }
  })
}

export function upsertRegionRow(regionId: string, patch: Partial<typeof mapRegions.$inferInsert>): void {
  const now = new Date()
  const existing = db.select().from(mapRegions).where(eq(mapRegions.regionId, regionId)).get()
  if (existing) {
    db.update(mapRegions).set({ ...patch, updatedAt: now }).where(eq(mapRegions.regionId, regionId)).run()
  } else {
    db.insert(mapRegions).values({
      id: crypto.randomUUID(),
      regionId,
      createdAt: now,
      updatedAt: now,
      ...patch,
    }).run()
  }
}

export async function removeRegion(regionId: string): Promise<void> {
  db.delete(mapRegions).where(eq(mapRegions.regionId, regionId)).run()
  const dir = regionDir(regionId)
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export function aggregateStorage(): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const s of listInstalledRegions()) {
    for (const [artifact, bytes] of Object.entries(s.bytesOnDisk)) {
      totals[artifact] = (totals[artifact] ?? 0) + bytes
    }
  }
  return totals
}

// Measure actual on-disk byte sizes for a region's artifacts.
export function measureRegionBytes(regionId: string): Record<string, number> {
  const dir = regionDir(regionId)
  const safeSize = (p: string): number => {
    try { return statSync(p).size } catch { return 0 }
  }
  return {
    street: safeSize(`${dir}/streets.pmtiles`),
    dem: safeSize(`${dir}/dem.pmtiles`),
    landcover: safeSize(`${dir}/landcover.pmtiles`),
    geocoder: safeSize(`${dir}/geocoder.sqlite`),
  }
}
