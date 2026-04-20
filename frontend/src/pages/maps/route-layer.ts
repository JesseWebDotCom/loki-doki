/**
 * MapLibre helpers for rendering route alternatives.
 *
 * Valhalla ships encoded polyline-6 strings; this module decodes them,
 * packs every alternative into a single GeoJSON FeatureCollection, and
 * manages a pair of source+layer pairs (alternates dim + selected
 * highlight + time-badge symbol layer). Re-rendering is cheap: the
 * single source gets `setData`, no source/layer remount unless the map
 * style was swapped from under us.
 */
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LineLayerSpecification,
  Map as MapLibreMap,
  SymbolLayerSpecification,
} from 'maplibre-gl';

const ROUTE_SOURCE_ID = 'ld-route-alts';
const ROUTE_LAYER_ID = 'ld-route-alts-line';
const ROUTE_BADGE_LAYER_ID = 'ld-route-alts-badge';

export const SELECTED_COLOR = '#A855F7';
export const ALT_COLOR = '#888888';

/**
 * Decode a polyline-6 string into an array of `[lng, lat]` pairs.
 *
 * Valhalla encodes with 1e6 precision (vs Google Maps' 1e5). The
 * algorithm is otherwise identical — variable-length quantities of
 * 5-bit groups with a continuation bit, signed zig-zag delta encoding.
 */
export function decodePolyline6(encoded: string): [number, number][] {
  return decodeWithPrecision(encoded, 1e6);
}

/** Public for tests — precision is injectable so a polyline-5 round-trip is verifiable. */
export function decodeWithPrecision(
  encoded: string,
  factor: number,
): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += deltaLat;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += deltaLng;

    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

export interface RouteAltForLayer {
  coords: [number, number][];
  duration_s: number;
  distance_m: number;
  is_fastest: boolean;
}

export interface RouteFeatureProperties {
  idx: number;
  selected: boolean;
  is_fastest: boolean;
  label: string;
}

/** Build the GeoJSON FeatureCollection that backs the route source. */
export function routesToFeatureCollection(
  alts: RouteAltForLayer[],
  selectedIdx: number,
): GeoJSON.FeatureCollection<GeoJSON.LineString, RouteFeatureProperties> {
  return {
    type: 'FeatureCollection',
    features: alts.map((alt, idx) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: alt.coords },
      properties: {
        idx,
        selected: idx === selectedIdx,
        is_fastest: alt.is_fastest,
        label: formatDurationLabel(alt.duration_s),
      },
    })),
  };
}

function formatDurationLabel(duration_s: number): string {
  const minutes = Math.max(1, Math.round(duration_s / 60));
  return `${minutes} min`;
}

/** Midpoint of a route's coordinate list — anchors the on-map time badge. */
export function midpoint(coords: [number, number][]): [number, number] | null {
  if (coords.length === 0) return null;
  return coords[Math.floor(coords.length / 2)];
}

// ── Paint expressions (selected vs. alternates) ──────────────────────

const LINE_COLOR_EXPR: ExpressionSpecification = [
  'case',
  ['boolean', ['get', 'selected'], false],
  SELECTED_COLOR,
  ALT_COLOR,
];

const LINE_WIDTH_EXPR: ExpressionSpecification = [
  'case',
  ['boolean', ['get', 'selected'], false],
  5,
  3,
];

const LINE_OPACITY_EXPR: ExpressionSpecification = [
  'case',
  ['boolean', ['get', 'selected'], false],
  1.0,
  0.5,
];

function lineLayer(): LineLayerSpecification {
  return {
    id: ROUTE_LAYER_ID,
    type: 'line',
    source: ROUTE_SOURCE_ID,
    layout: {
      'line-cap': 'round',
      'line-join': 'round',
      // Selected line on top of alternates.
      'line-sort-key': ['case', ['boolean', ['get', 'selected'], false], 1, 0],
    },
    paint: {
      'line-color': LINE_COLOR_EXPR,
      'line-width': LINE_WIDTH_EXPR,
      'line-opacity': LINE_OPACITY_EXPR,
    },
  };
}

function badgeLayer(): SymbolLayerSpecification {
  return {
    id: ROUTE_BADGE_LAYER_ID,
    type: 'symbol',
    source: ROUTE_SOURCE_ID,
    layout: {
      'symbol-placement': 'line-center',
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Medium'],
      'text-size': 12,
      'text-padding': 2,
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': [
        'case',
        ['boolean', ['get', 'selected'], false],
        SELECTED_COLOR,
        '#222222',
      ],
      'text-halo-width': 3,
    },
  };
}

// ── Map wiring ──────────────────────────────────────────────────────

/**
 * Install (or refresh) the source + layers on the given map. Idempotent:
 * calling with an empty list clears the visible routes without tearing
 * down the source, so the next fetch just swaps data.
 */
export function applyRoutes(
  map: MapLibreMap,
  alts: RouteAltForLayer[],
  selectedIdx: number,
): void {
  const fc = routesToFeatureCollection(alts, selectedIdx);
  const existing = map.getSource(ROUTE_SOURCE_ID);
  if (existing) {
    (existing as GeoJSONSource).setData(fc);
  } else {
    map.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data: fc });
  }
  if (!map.getLayer(ROUTE_LAYER_ID)) {
    map.addLayer(lineLayer());
  }
  if (!map.getLayer(ROUTE_BADGE_LAYER_ID)) {
    map.addLayer(badgeLayer());
  }
}

/** Remove every route-layer artifact (used when the panel closes). */
export function clearRoutes(map: MapLibreMap): void {
  if (map.getLayer(ROUTE_BADGE_LAYER_ID)) map.removeLayer(ROUTE_BADGE_LAYER_ID);
  if (map.getLayer(ROUTE_LAYER_ID)) map.removeLayer(ROUTE_LAYER_ID);
  if (map.getSource(ROUTE_SOURCE_ID)) map.removeSource(ROUTE_SOURCE_ID);
}

/** Compute a bounding box that fits every coordinate of every alternative. */
export function boundsForAlts(
  alts: RouteAltForLayer[],
): [[number, number], [number, number]] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const alt of alts) {
    for (const [lng, lat] of alt.coords) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minLng)) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

export const ROUTE_LAYER_IDS = {
  source: ROUTE_SOURCE_ID,
  line: ROUTE_LAYER_ID,
  badge: ROUTE_BADGE_LAYER_ID,
};
