/**
 * MapLibre helpers for rendering route alternatives.
 *
 * GraphHopper ships polyline strings (precision 6 by default, configurable
 * to 5 — we always use 6). This module decodes them, packs every
 * alternative into a single GeoJSON FeatureCollection, and manages a
 * pair of source+layer pairs (alternates dim + selected highlight +
 * time-badge symbol layer). Re-rendering is cheap: the single source
 * gets `setData`, no source/layer remount unless the map style was
 * swapped from under us.
 */
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LineLayerSpecification,
  Map as MapLibreMap,
  SymbolLayerSpecification,
} from "maplibre-gl";

const ROUTE_SOURCE_ID = "ld-route-alts";
const ROUTE_GLOW_LAYER_ID = "ld-route-alts-glow";
const ROUTE_LAYER_ID = "ld-route-alts-line";
const ROUTE_BADGE_LAYER_ID = "ld-route-alts-badge";
const SELECTED_STEP_SOURCE_ID = "ld-route-step";
const SELECTED_STEP_LAYER_ID = "ld-route-step-line";

export const SELECTED_COLOR = "#A855F7";
export const ALT_COLOR = "#888888";
export const STEP_HIGHLIGHT_COLOR = "#22D3EE";

/**
 * Decode a GraphHopper polyline string into an array of `[lng, lat]` pairs.
 *
 * GraphHopper encodes with 1e6 precision (vs Google Maps' 1e5). The
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

/**
 * GraphHopper can also return a `{points: {coordinates: [[lng,lat],...]}}`
 * GeoJSON-ish object when `points_encoded=false`. The directions API
 * here uses encoded polyline6, but the parser is permissive so a
 * downstream switch is one-line.
 */
export function decodeGeometry(geometry: string): [number, number][] {
  if (!geometry) return [];
  if (geometry.startsWith("{") || geometry.startsWith("[")) {
    try {
      const parsed = JSON.parse(geometry) as
        | { coordinates?: unknown }
        | unknown[];
      const coords =
        Array.isArray(parsed) ? parsed : (parsed as { coordinates?: unknown }).coordinates;
      if (Array.isArray(coords)) {
        return (coords as [number, number][]).filter(
          (c) => Array.isArray(c) && c.length === 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]),
        );
      }
      return [];
    } catch {
      return [];
    }
  }
  return decodePolyline6(geometry);
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
    type: "FeatureCollection",
    features: alts.map((alt, idx) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: alt.coords },
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
  "case",
  ["boolean", ["get", "selected"], false],
  SELECTED_COLOR,
  ALT_COLOR,
];

const LINE_WIDTH_EXPR: ExpressionSpecification = [
  "case",
  ["boolean", ["get", "selected"], false],
  5,
  3,
];

const LINE_OPACITY_EXPR: ExpressionSpecification = [
  "case",
  ["boolean", ["get", "selected"], false],
  1.0,
  0.5,
];

function glowLayer(): LineLayerSpecification {
  // Wider, blurred underlay drawn only for the selected route. Sits under
  // `lineLayer` to produce a soft halo without obscuring the crisp center
  // stroke — the "neon trail" treatment that reads as Tesla-style nav.
  return {
    id: ROUTE_GLOW_LAYER_ID,
    type: "line",
    source: ROUTE_SOURCE_ID,
    filter: ["boolean", ["get", "selected"], false],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": SELECTED_COLOR,
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 8, 14, 14, 18, 22],
      "line-blur": 6,
      "line-opacity": 0.55,
    },
  };
}

function lineLayer(): LineLayerSpecification {
  return {
    id: ROUTE_LAYER_ID,
    type: "line",
    source: ROUTE_SOURCE_ID,
    layout: {
      "line-cap": "round",
      "line-join": "round",
      "line-sort-key": ["case", ["boolean", ["get", "selected"], false], 1, 0],
    },
    paint: {
      "line-color": LINE_COLOR_EXPR,
      "line-width": LINE_WIDTH_EXPR,
      "line-opacity": LINE_OPACITY_EXPR,
    },
  };
}

function badgeLayer(): SymbolLayerSpecification {
  return {
    id: ROUTE_BADGE_LAYER_ID,
    type: "symbol",
    source: ROUTE_SOURCE_ID,
    layout: {
      "symbol-placement": "line-center",
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Medium"],
      "text-size": 12,
      "text-padding": 2,
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": [
        "case",
        ["boolean", ["get", "selected"], false],
        SELECTED_COLOR,
        "#222222",
      ],
      "text-halo-width": 3,
    },
  };
}

function stepLayer(): LineLayerSpecification {
  return {
    id: SELECTED_STEP_LAYER_ID,
    type: "line",
    source: SELECTED_STEP_SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": STEP_HIGHLIGHT_COLOR,
      "line-width": 7,
      "line-opacity": 0.9,
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
    map.addSource(ROUTE_SOURCE_ID, { type: "geojson", data: fc });
  }
  if (!map.getLayer(ROUTE_GLOW_LAYER_ID)) {
    map.addLayer(glowLayer());
  }
  if (!map.getLayer(ROUTE_LAYER_ID)) {
    map.addLayer(lineLayer());
  }
  if (!map.getLayer(ROUTE_BADGE_LAYER_ID)) {
    map.addLayer(badgeLayer());
  }
}

/** Paint the currently-selected step as a brighter overlay. */
export function applySelectedStep(
  map: MapLibreMap,
  coords: [number, number][] | null,
): void {
  const empty: GeoJSON.FeatureCollection<GeoJSON.LineString> = {
    type: "FeatureCollection",
    features: [],
  };
  const fc: GeoJSON.FeatureCollection<GeoJSON.LineString> = coords && coords.length > 1
    ? {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: coords },
            properties: {},
          },
        ],
      }
    : empty;
  const existing = map.getSource(SELECTED_STEP_SOURCE_ID);
  if (existing) {
    (existing as GeoJSONSource).setData(fc);
  } else {
    map.addSource(SELECTED_STEP_SOURCE_ID, { type: "geojson", data: fc });
  }
  if (!map.getLayer(SELECTED_STEP_LAYER_ID)) {
    map.addLayer(stepLayer());
  }
}

/** Remove every route-layer artifact (used when the panel closes). */
export function clearRoutes(map: MapLibreMap): void {
  if (map.getLayer(SELECTED_STEP_LAYER_ID)) map.removeLayer(SELECTED_STEP_LAYER_ID);
  if (map.getSource(SELECTED_STEP_SOURCE_ID)) map.removeSource(SELECTED_STEP_SOURCE_ID);
  if (map.getLayer(ROUTE_BADGE_LAYER_ID)) map.removeLayer(ROUTE_BADGE_LAYER_ID);
  if (map.getLayer(ROUTE_LAYER_ID)) map.removeLayer(ROUTE_LAYER_ID);
  if (map.getLayer(ROUTE_GLOW_LAYER_ID)) map.removeLayer(ROUTE_GLOW_LAYER_ID);
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
  glow: ROUTE_GLOW_LAYER_ID,
  line: ROUTE_LAYER_ID,
  badge: ROUTE_BADGE_LAYER_ID,
  stepSource: SELECTED_STEP_SOURCE_ID,
  stepLine: SELECTED_STEP_LAYER_ID,
};

// Phase maps-skill chunk-04: compute a bounding box around a decoded route polyline.
export function computeRouteBbox(
  coords: [number, number][],
  bufferKm = 2,
): [number, number, number, number] | null {
  if (!coords.length) return null;
  const lats = coords.map(([, lat]) => lat);
  const lons = coords.map(([lon]) => lon);
  const latDelta = bufferKm / 110.574;
  const latMid = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lonDelta = bufferKm / (111.32 * Math.max(0.1, Math.cos((latMid * Math.PI) / 180)));
  return [
    Math.min(...lons) - lonDelta, Math.min(...lats) - latDelta,
    Math.max(...lons) + lonDelta, Math.max(...lats) + latDelta,
  ];
}
