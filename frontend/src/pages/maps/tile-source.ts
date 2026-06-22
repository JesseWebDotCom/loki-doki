import type { InstalledRegion } from "./types";

export interface ViewportBounds {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface TileSourceResult {
  activeRegion: InstalledRegion | null;
  outOfCoverage: boolean;
  tileUrl: string | null;
}

export function chooseTileSource(
  regions: InstalledRegion[],
  center: { lat: number; lon: number },
  viewport?: ViewportBounds,
): TileSourceResult {
  // Prefer center-inside match so the "active" region is the one the user is
  // actually looking at, not just a neighboring region that bleeds into the frame.
  let activeRegion = regions.find((region) => contains(region.bbox, center)) ?? null;
  // Fall back to viewport intersection so tiles load as soon as a region is
  // visible — even before the map center crosses into the bbox (e.g. when the
  // user zooms in from a northern starting point while CT is at the bottom of
  // the viewport).
  if (!activeRegion && viewport) {
    activeRegion = regions.find((region) => intersects(region.bbox, viewport)) ?? null;
  }
  return {
    activeRegion,
    outOfCoverage: activeRegion === null,
    tileUrl: activeRegion ? `pmtiles:///api/maps/tiles/${activeRegion.region_id}/streets.pmtiles` : null,
  };
}

function contains(
  bbox: [number, number, number, number],
  center: { lat: number; lon: number },
): boolean {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return center.lon >= minLon && center.lon <= maxLon && center.lat >= minLat && center.lat <= maxLat;
}

function intersects(
  bbox: [number, number, number, number],
  viewport: ViewportBounds,
): boolean {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return !(viewport.maxLon < minLon || viewport.minLon > maxLon ||
           viewport.maxLat < minLat || viewport.minLat > maxLat);
}
