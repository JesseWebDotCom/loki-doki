/**
 * Resolve the tile source MapLibre should render from.
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
}

export type ResolveResult =
  | {
      kind: 'local';
      region: string;
      label: string;
      streetUrl: string;
      bbox: BBox;
    }
  | { kind: 'none' };

// ── Raw region fetch ──────────────────────────────────────────────

interface RawRegion {
  region_id: string;
  label?: string;
  bbox?: BBox;
  center?: { lat: number; lon: number };
  state?: { street_installed?: boolean };
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
          Boolean(r.state?.street_installed),
      )
      .map((r) => ({
        region_id: r.region_id,
        label: r.label ?? r.region_id,
        bbox: r.bbox,
        center: r.center,
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

/** Squared great-circle-ish distance between two lng/lat points. */
function centerDist2(a: LngLat, b: { lat: number; lon: number }): number {
  const dx = a.lng - b.lon;
  const dy = a.lat - b.lat;
  return dx * dx + dy * dy;
}

function asLocal(r: InstalledRegion): ResolveResult {
  return {
    kind: 'local',
    region: r.region_id,
    label: r.label,
    streetUrl: `pmtiles:///api/v1/maps/tiles/${r.region_id}/streets.pmtiles`,
    bbox: r.bbox,
  };
}

/**
 * Pick the tile source for a given viewport centre.
 *
 * Offline-first: we never reach out to a remote tile CDN. When at least
 * one region is installed the source is ALWAYS the local pmtiles route
 * and we never flip it mid-session (flipping would call `map.setStyle()`
 * which clears rendered tiles and causes a visible "flash → blank"
 * every time the viewport crossed an installed bbox boundary). When the
 * viewport is outside every bbox we fall back to the *nearest* installed
 * region rather than going online. When no regions are installed at all
 * the resolver returns `kind: 'none'` — the empty-state overlay guides
 * the user to install one.
 */
export async function resolveTileSource(
  center?: LngLat,
  regionsInput?: InstalledRegion[],
): Promise<ResolveResult> {
  const regions = regionsInput ?? (await fetchInstalledRegions());

  if (regions.length === 0) {
    return { kind: 'none' };
  }

  const probe: LngLat =
    center ?? { lng: regions[0].center.lon, lat: regions[0].center.lat };

  const covering = regions.find((r) => bboxContains(r.bbox, probe));
  if (covering) return asLocal(covering);

  // Outside every bbox: stick with the nearest installed region so the
  // tile source doesn't churn. The user sees empty space outside the
  // region's coverage area (correct offline behavior) without a full
  // style rebuild on every pan.
  let nearest = regions[0];
  let best = centerDist2(probe, regions[0].center);
  for (let i = 1; i < regions.length; i++) {
    const d = centerDist2(probe, regions[i].center);
    if (d < best) {
      best = d;
      nearest = regions[i];
    }
  }
  return asLocal(nearest);
}

// Re-export the fetch helper so the page can hydrate once and reuse.
export { fetchInstalledRegions };
