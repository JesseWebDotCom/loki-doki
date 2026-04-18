/**
 * Resolve the tile source MapLibre should render from.
 *
 * Chunk 3 replaces the stub with a real multi-region resolver:
 *
 *  1. Fetches the installed-region list from the backend.
 *  2. Merges every region's bbox into a coverage polygon.
 *  3. Picks the first region whose bbox contains the current viewport
 *     centre, returning a local `pmtiles://` URL pointed at the
 *     backend's sendfile route.
 *  4. Falls back to the online Protomaps demo when we are online but
 *     outside every installed region, and to `kind: "none"` when we
 *     are offline and outside coverage — the `OutOfCoverageBanner`
 *     surfaces that case.
 */
export type LngLat = { lng: number; lat: number };

export type BBox = [number, number, number, number];

export interface InstalledRegion {
  region_id: string;
  label: string;
  bbox: BBox;
  center: { lat: number; lon: number };
  has_satellite: boolean;
}

export type ResolveResult =
  | {
      kind: 'local';
      region: string;
      label: string;
      streetUrl: string;
      satUrlTemplate: string | null;
      bbox: BBox;
    }
  | { kind: 'online'; streetUrl: string }
  | { kind: 'none' };

const ONLINE_DEMO_URL =
  'pmtiles://https://demo-bucket.protomaps.com/v4.pmtiles';

// ── Raw region fetch ──────────────────────────────────────────────

interface RawRegion {
  region_id: string;
  label?: string;
  bbox?: BBox;
  center?: { lat: number; lon: number };
  state?: { satellite_installed?: boolean; street_installed?: boolean };
}

async function fetchInstalledRegions(): Promise<InstalledRegion[]> {
  try {
    const res = await fetch('/api/v1/maps/regions');
    if (!res.ok) return [];
    const raw = (await res.json()) as RawRegion[];
    return raw
      .filter(
        (r): r is RawRegion & Required<Pick<RawRegion, 'bbox' | 'center'>> =>
          Array.isArray(r.bbox) && r.bbox.length === 4 && r.center != null &&
          // Only surface regions whose vector basemap is actually on disk —
          // a partial install (satellite only) should not claim coverage.
          Boolean(r.state?.street_installed),
      )
      .map((r) => ({
        region_id: r.region_id,
        label: r.label ?? r.region_id,
        bbox: r.bbox,
        center: r.center,
        has_satellite: Boolean(r.state?.satellite_installed),
      }));
  } catch {
    return [];
  }
}

// ── Coverage helpers ──────────────────────────────────────────────

/** Does the given point fall inside a bbox `[minLon, minLat, maxLon, maxLat]`? */
function bboxContains(bbox: BBox, center: LngLat): boolean {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return (
    center.lng >= minLon &&
    center.lng <= maxLon &&
    center.lat >= minLat &&
    center.lat <= maxLat
  );
}

function bboxToPolygon(bbox: BBox): GeoJSON.Polygon {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ],
  };
}

/** Merge every installed region's bbox into a single GeoJSON MultiPolygon. */
export function mergedCoverage(
  regions: InstalledRegion[],
): GeoJSON.MultiPolygon {
  return {
    type: 'MultiPolygon',
    coordinates: regions.map((r) => bboxToPolygon(r.bbox).coordinates),
  };
}

/** Is the point inside any polygon of the merged coverage? */
export function inCoverage(
  center: LngLat,
  coverage: GeoJSON.MultiPolygon,
): boolean {
  // Each polygon coordinate list is a ring whose first four points form
  // the bbox; we only ever produce axis-aligned rectangles here, so a
  // bounds check is exact (and much cheaper than point-in-polygon).
  for (const poly of coverage.coordinates) {
    const ring = poly[0];
    if (!ring || ring.length < 4) continue;
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    if (
      center.lng >= minLon &&
      center.lng <= maxLon &&
      center.lat >= minLat &&
      center.lat <= maxLat
    ) {
      return true;
    }
  }
  return false;
}

// ── Main resolver ─────────────────────────────────────────────────

function isBrowserOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

/**
 * Pick the tile source for a given viewport centre.
 *
 * If `center` is omitted we behave like initial load and treat a single
 * installed region as "covering" — useful before the map has reported a
 * centre. When multiple regions exist we require an explicit centre to
 * disambiguate.
 */
export async function resolveTileSource(
  center?: LngLat,
  regionsInput?: InstalledRegion[],
): Promise<ResolveResult> {
  const regions = regionsInput ?? (await fetchInstalledRegions());

  if (regions.length === 0) {
    return isBrowserOnline()
      ? { kind: 'online', streetUrl: ONLINE_DEMO_URL }
      : { kind: 'none' };
  }

  // With no centre, bias toward the first installed region so the map
  // initialises on something renderable.
  const probe: LngLat =
    center ?? { lng: regions[0].center.lon, lat: regions[0].center.lat };

  const match = regions.find((r) => bboxContains(r.bbox, probe));
  if (match) {
    return {
      kind: 'local',
      region: match.region_id,
      label: match.label,
      streetUrl: `pmtiles:///api/v1/maps/tiles/${match.region_id}/streets.pmtiles`,
      satUrlTemplate: match.has_satellite
        ? `/api/v1/maps/tiles/${match.region_id}/sat/{z}/{x}/{y}.jpg`
        : null,
      bbox: match.bbox,
    };
  }

  return isBrowserOnline()
    ? { kind: 'online', streetUrl: ONLINE_DEMO_URL }
    : { kind: 'none' };
}

// Re-export the fetch helper so the page can hydrate once and reuse.
export { fetchInstalledRegions };
