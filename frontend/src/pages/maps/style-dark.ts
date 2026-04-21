/**
 * MapLibre style targeting the OpenMapTiles vector schema that
 * planetiler produces into ``streets.pmtiles``. The schema uses source
 * layers like ``transportation`` / ``place`` / ``boundary`` / ``building``
 * / ``transportation_name`` / ``housenumber`` / ``poi`` / ``water_name``
 * with ``class`` as the kind discriminator — notably different from the
 * Protomaps basemap schema (``roads`` / ``places`` / ``boundaries`` /
 * ``buildings``) an earlier draft of this file targeted. Mismatched
 * source-layer names render silently as blank tiles — hence the style
 * must match the producer.
 *
 * Supports two themes and two modes:
 *  - ``theme: 'dark' | 'light'`` — palette swap. Default 'dark'.
 *  - ``mode: 'map' | '3d'`` — 3D flips on a building fill-extrusion
 *    layer that reads ``render_height`` / ``render_min_height`` from
 *    the tiles (OpenMapTiles already resolves OSM ``height`` /
 *    ``building:levels`` into these at build time).
 */
import type maplibregl from 'maplibre-gl';
import { POI_CATEGORY_ICON } from './panels/poi-icons';

export type LayerMode = 'map' | '3d';

export interface Palette {
  background: string;
  water: string;
  water_shadow: string;
  park: string;
  residential: string;
  landuse_park: string;
  landuse_wood: string;
  landuse_residential: string;
  landuse_commercial: string;
  landuse_industrial: string;
  road_minor: string;
  road_secondary: string;
  road_primary: string;
  road_trunk: string;
  road_motorway: string;
  road_medium: string;
  road_major: string;
  road_casing: string;
  road_major_label: string;
  building: string;
  building_outline: string;
  boundary_country: string;
  boundary_state: string;
  place_label: string;
  place_label_halo: string;
  street_label: string;
  street_label_halo: string;
  water_label: string;
  water_label_halo: string;
  poi_label: string;
  housenumber: string;
}

const DARK: Palette = {
  background: '#141518',
  water: '#0f2944',
  water_shadow: '#173754',
  park: '#1b2d1e',
  residential: '#1e2128',
  landuse_park: '#1c2620',
  landuse_wood: '#1a221c',
  landuse_residential: '#1f1d22',
  landuse_commercial: '#221f25',
  landuse_industrial: '#1d2128',
  road_minor: '#3a3f47',
  road_secondary: '#8f96a3',
  road_primary: '#f1b45a',
  road_trunk: '#3f92f5',
  road_motorway: '#1c6ff2',
  road_medium: '#6e7887',
  road_major: '#9aa3ad',
  road_casing: '#101827',
  road_major_label: '#1b4b9b',
  building: '#363b48',
  building_outline: '#4a5060',
  boundary_country: '#b49bff',
  boundary_state: '#7d6da8',
  place_label: '#f0f2f7',
  place_label_halo: '#0a0c10',
  street_label: '#c7cddd',
  street_label_halo: '#0a0c10',
  water_label: '#7aa8d8',
  water_label_halo: '#0a0c10',
  poi_label: '#a5adbf',
  housenumber: '#8892ab',
};

export { DARK };

export interface DarkStyleOptions {
  mode?: LayerMode;
  palette?: Palette;
}

export const POI_COLORS: Record<string, string> = {
  restaurant: '#f59e0b',
  cafe: '#f97316',
  fast_food: '#ef4444',
  bar: '#a855f7',
  pub: '#7c3aed',
  grocery: '#22c55e',
  shop: '#38bdf8',
  convenience: '#10b981',
  pharmacy: '#ec4899',
  bank: '#3b82f6',
  atm: '#2563eb',
  gas: '#f97316',
  parking: '#94a3b8',
  school: '#facc15',
  hospital: '#ef4444',
  clinic: '#fb7185',
  library: '#eab308',
  museum: '#c084fc',
  hotel: '#06b6d4',
  lodging: '#0891b2',
  transit_bus: '#14b8a6',
  transit_train: '#10b981',
  transit_subway: '#22c55e',
  airport: '#8b5cf6',
  park: '#16a34a',
  place_of_worship: '#f43f5e',
  post: '#fb7185',
  police: '#60a5fa',
  fire_station: '#dc2626',
  default: '#cbd5e1',
};

// Sprite mapping is the single source of truth in `panels/poi-icons`.
// Drop the trailing `default` entry because the `match` expression
// below consumes its own fallback argument.
const POI_ICON_BY_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(POI_CATEGORY_ICON).filter(([key]) => key !== 'default'),
);

const POI_COLOR_BY_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(POI_ICON_BY_KEY).map(([key, icon]) => [key, POI_COLORS[icon] ?? POI_COLORS.default]),
);

const poiMatchExpression = (
  mapping: Record<string, string>,
  fallback: string,
): maplibregl.ExpressionSpecification => {
  const pairs = Object.entries(mapping).flatMap(([key, value]) => [key, value]);
  return [
    'match',
    ['coalesce', ['get', 'subclass'], ['get', 'class']],
    ...pairs,
    fallback,
  ] as unknown as maplibregl.ExpressionSpecification;
};

// ── Layer builders ────────────────────────────────────────────────

const fillLayers = (p: Palette): maplibregl.LayerSpecification[] => [
  // Parks and protected greenspace from planetiler's dedicated park layer.
  {
    id: 'landuse_park',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'park',
    paint: { 'fill-color': p.landuse_park, 'fill-opacity': 0.55 },
  },
  // Residential neighborhoods.
  {
    id: 'landuse_residential',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'landuse',
    filter: ['==', ['get', 'class'], 'residential'],
    paint: { 'fill-color': p.landuse_residential, 'fill-opacity': 0.5 },
  },
  // Commercial cores and shopping districts.
  {
    id: 'landuse_commercial',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'landuse',
    filter: ['==', ['get', 'class'], 'commercial'],
    paint: { 'fill-color': p.landuse_commercial, 'fill-opacity': 0.5 },
  },
  // Industrial areas lean slightly cooler so the road hierarchy stands out.
  {
    id: 'landuse_industrial',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'landuse',
    filter: ['==', ['get', 'class'], 'industrial'],
    paint: { 'fill-color': p.landuse_industrial, 'fill-opacity': 0.52 },
  },
  // Woodlands and broader greenspace from landcover.
  {
    id: 'landuse_wood',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'landcover',
    filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass', 'farmland']]],
    paint: { 'fill-color': p.landuse_wood, 'fill-opacity': 0.45 },
  },
  // Water polygons.
  {
    id: 'water',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'water',
    paint: {
      'fill-color': p.water,
      'fill-outline-color': p.water_shadow,
    },
  },
  // Faint outline so coastlines and large lakes read cleanly in both themes.
  {
    id: 'water_shadow',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'water',
    paint: {
      'line-color': p.water_shadow,
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 12, 1.1],
      'line-opacity': 0.5,
    },
  },
  // Waterway lines.
  {
    id: 'waterway',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'waterway',
    paint: {
      'line-color': p.water,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 16, 2.5],
    },
  },
];

const roadLayers = (p: Palette): maplibregl.LayerSpecification[] => [
  // Casings (dark outline under major/medium roads).
  {
    id: 'roads_casing',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'transportation',
    filter: [
      'in',
      ['get', 'class'],
      ['literal', ['motorway', 'trunk', 'primary', 'secondary']],
    ],
    minzoom: 7,
    paint: {
      'line-color': p.road_casing,
      'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.6, 12, 3.4, 18, 13],
      'line-opacity': 0.78,
    },
  },
  // Paths / tracks — only visible close up.
  {
    id: 'roads_path',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'transportation',
    filter: ['in', ['get', 'class'], ['literal', ['path', 'track']]],
    minzoom: 13,
    paint: {
      'line-color': p.road_minor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.4, 18, 1.5],
      'line-dasharray': [2, 2],
      'line-opacity': 0.7,
    },
  },
  // Minor roads (residential, service, minor).
  {
    id: 'roads_minor',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'transportation',
    filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'residential']]],
    minzoom: 13,
    paint: {
      'line-color': p.road_minor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.4, 16, 1.6, 18, 3],
    },
  },
  // Tertiary.
  {
    id: 'roads_tertiary',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'transportation',
    filter: ['==', ['get', 'class'], 'tertiary'],
    minzoom: 8,
    paint: {
      'line-color': p.road_minor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 18, 5],
    },
  },
  // Secondary / Primary.
  {
    id: 'roads_medium',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'transportation',
    filter: ['in', ['get', 'class'], ['literal', ['secondary', 'primary']]],
    minzoom: 6,
    paint: {
      'line-color': p.road_medium,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 12, 2, 16, 5],
    },
  },
  // Motorway / Trunk.
  {
    id: 'roads_major',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'transportation',
    filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk']]],
    minzoom: 4,
    paint: {
      'line-color': [
        'match',
        ['get', 'class'],
        'motorway', p.road_motorway,
        'trunk', p.road_trunk,
        p.road_major,
      ],
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.3, 8, 2.2, 12, 4.4, 16, 9.2],
      'line-opacity': 0.98,
    },
  },
  // Primary and secondary routes get their own brighter color split so
  // the highway hierarchy stays legible even before shields appear.
  {
    id: 'roads_medium_colored',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'transportation',
    filter: ['in', ['get', 'class'], ['literal', ['secondary', 'primary']]],
    minzoom: 8,
    paint: {
      'line-color': [
        'match',
        ['get', 'class'],
        'primary', p.road_primary,
        'secondary', p.road_secondary,
        p.road_medium,
      ],
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.9, 12, 2.2, 16, 5.4],
      'line-opacity': 0.95,
    },
  },
];

// ── World overview layers (Natural Earth via world-overview.pmtiles) ──
//
// These read from the second vector source (`world_overview`) — a global
// z0–z7 pmtiles built by bootstrap from Natural Earth. Every world-
// overview layer carries ``maxzoom: 7`` so the per-region source takes
// over at street zoom and the two sources never stack at the same zoom.
// Paint order is controlled in `buildDarkStyle` below — fills go under
// the region source, symbols coexist alongside region place labels.

const worldOverviewFillLayers = (p: Palette): maplibregl.LayerSpecification[] => [
  // Natural Earth glaciers / ice caps come through on `landcover`.
  // Renders as a very low-contrast land-tone fill where present;
  // elsewhere the bg color shows through — that's the intended look.
  {
    id: 'world_background_fill',
    type: 'fill',
    source: 'world_overview',
    'source-layer': 'landcover',
    maxzoom: 7,
    paint: { 'fill-color': p.residential, 'fill-opacity': 0.5 },
  },
  // Ocean / major lakes from Natural Earth water polygons.
  {
    id: 'world_water',
    type: 'fill',
    source: 'world_overview',
    'source-layer': 'water',
    maxzoom: 7,
    paint: { 'fill-color': p.water },
  },
];

const worldOverviewBoundaryLayers = (
  p: Palette,
): maplibregl.LayerSpecification[] => [
  {
    id: 'world_boundary_state',
    type: 'line',
    source: 'world_overview',
    'source-layer': 'boundary',
    filter: ['==', ['get', 'admin_level'], 4],
    maxzoom: 7,
    paint: {
      'line-color': p.boundary_state,
      'line-width': 0.6,
      'line-dasharray': [3, 2],
      'line-opacity': 0.8,
    },
  },
  {
    id: 'world_boundary_country',
    type: 'line',
    source: 'world_overview',
    'source-layer': 'boundary',
    filter: ['<=', ['get', 'admin_level'], 2],
    maxzoom: 7,
    paint: {
      'line-color': p.boundary_country,
      'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 7, 1.4],
    },
  },
];

// Country + state labels. Read from a static GeoJSON source (built at
// bootstrap time from Natural Earth) rather than the pmtiles ``place``
// source-layer — planetiler's OpenMapTiles profile sources ``place=*``
// from OSM, and our world-overview build feeds it a Monaco-only OSM
// input, so the pmtiles ``place`` layer contains exactly one country
// (Monaco). The GeoJSON approach sidesteps that limitation entirely.
//
// Each feature carries ``min_zoom`` / ``max_zoom`` / ``rank`` properties
// extracted from Natural Earth's ``min_label`` / ``max_label`` /
// ``labelrank`` columns — the filters below stage labels across all
// zooms without re-generating the style.
const worldOverviewPlaceLayers = (
  p: Palette,
): maplibregl.LayerSpecification[] => [
  {
    id: 'world_place_country',
    type: 'symbol',
    source: 'world_labels',
    filter: [
      'all',
      ['==', ['get', 'kind'], 'country'],
      ['>=', ['zoom'], ['get', 'min_zoom']],
      ['<=', ['zoom'], ['get', 'max_zoom']],
    ],
    minzoom: 1,
    layout: {
      'symbol-placement': 'point',
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 5, 20, 9, 16, 14, 14],
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.15,
      'text-max-width': 9,
      'text-padding': 2,
      'text-variable-anchor': ['center', 'top', 'bottom', 'left', 'right'],
      'text-justify': 'auto',
    },
    paint: {
      'text-color': p.place_label,
      'text-halo-color': p.place_label_halo,
      'text-halo-width': 1.6,
    },
  },
  {
    id: 'world_place_state',
    type: 'symbol',
    source: 'world_labels',
    filter: [
      'all',
      ['==', ['get', 'kind'], 'state'],
      ['>=', ['zoom'], ['get', 'min_zoom']],
      ['<=', ['zoom'], ['get', 'max_zoom']],
    ],
    minzoom: 3,
    layout: {
      'symbol-placement': 'point',
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 7, 15, 9, 12, 14, 11],
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.1,
      'text-max-width': 8,
      'text-padding': 2,
      'text-variable-anchor': ['center', 'top', 'bottom', 'left', 'right'],
      'text-justify': 'auto',
    },
    paint: {
      'text-color': p.place_label,
      'text-halo-color': p.place_label_halo,
      'text-halo-width': 1.3,
      'text-opacity': 0.85,
    },
  },
];

// Global admin-1 (state / province / land / oblast) boundaries + labels.
// Reads polygons from the same Natural Earth-derived `world_labels`
// GeoJSON source the country/state symbol layers already use; a
// `line` layer over polygon geometry renders the outlines, and a
// separate `symbol` layer places admin-1 names at polygon centroids.
//
// The previous `world_boundary_state` layer (filter admin_level=4 on
// the planetiler `boundary` source-layer) only carried features for
// the US, because OpenMapTiles seeds NE admin-1 only for adm0_a3=USA
// and our world-overview build feeds planetiler a Monaco-only OSM
// extract. Sourcing from the GeoJSON closes that gap globally —
// Mexico's Aguascalientes / Jalisco / Querétaro, Canada's Ontario /
// Quebec, German Länder, Indian states, etc — without a planetiler
// schema rewrite.
const worldOverviewAdmin1BoundaryLayers = (
  p: Palette,
): maplibregl.LayerSpecification[] => [
  {
    id: 'world_admin1_boundary',
    type: 'line',
    source: 'world_labels',
    filter: ['==', ['get', 'kind'], 'state'],
    minzoom: 4,
    maxzoom: 8,
    paint: {
      'line-color': p.boundary_state,
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 8, 0.9],
      'line-dasharray': [2, 3],
      'line-opacity': 0.65,
    },
  },
];

const worldOverviewAdmin1LabelLayers = (
  p: Palette,
): maplibregl.LayerSpecification[] => [
  {
    id: 'world_admin1_label',
    type: 'symbol',
    source: 'world_labels',
    filter: ['==', ['get', 'kind'], 'state'],
    minzoom: 4,
    maxzoom: 8,
    layout: {
      'symbol-placement': 'point',
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-letter-spacing': 0.08,
      'text-transform': 'uppercase',
      'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 7, 12],
      'text-padding': 2,
      'text-max-width': 8,
      'text-variable-anchor': ['center', 'top', 'bottom', 'left', 'right'],
      'text-justify': 'auto',
    },
    paint: {
      'text-color': p.place_label,
      'text-halo-color': p.place_label_halo,
      'text-halo-width': 1.3,
      'text-opacity': 0.85,
    },
  },
];

const boundaryLayers = (p: Palette): maplibregl.LayerSpecification[] => [
  {
    id: 'boundary_state',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'boundary',
    filter: ['==', ['get', 'admin_level'], 4],
    paint: {
      'line-color': p.boundary_state,
      'line-width': 0.7,
      'line-dasharray': [3, 2],
    },
  },
  {
    id: 'boundary_country',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'boundary',
    filter: ['<=', ['get', 'admin_level'], 2],
    paint: {
      'line-color': p.boundary_country,
      'line-width': 1.4,
    },
  },
];

// Street name labels follow the road centerline. The ``class`` filter
// scopes each sub-layer so motorways stay legible at low zoom and
// residential street labels don't swamp the view until close in.
const transportationNameLayers = (
  p: Palette,
): maplibregl.LayerSpecification[] => [
  {
    id: 'street_label_major',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'transportation_name',
    filter: [
      'in',
      ['get', 'class'],
      ['literal', ['motorway', 'trunk', 'primary']],
    ],
    minzoom: 9,
    layout: {
      'symbol-placement': 'line',
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Medium'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 12, 14, 15, 18, 20],
      'text-letter-spacing': 0.04,
      'text-max-angle': 30,
    },
    paint: {
      'text-color': p.road_major_label,
      'text-halo-color': p.street_label_halo,
      'text-halo-width': 1.8,
    },
  },
  {
    id: 'street_label_medium',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'transportation_name',
    filter: ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary']]],
    minzoom: 11,
    layout: {
      'symbol-placement': 'line',
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 14, 13, 18, 17],
      'text-letter-spacing': 0.02,
      'text-max-angle': 30,
    },
    paint: {
      'text-color': p.street_label,
      'text-halo-color': p.street_label_halo,
      'text-halo-width': 1.4,
    },
  },
  {
    id: 'street_label_minor',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'transportation_name',
    filter: [
      'in',
      ['get', 'class'],
      ['literal', ['minor', 'service', 'residential']],
    ],
    minzoom: 14,
    layout: {
      'symbol-placement': 'line',
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 18, 16],
      'text-max-angle': 30,
    },
    paint: {
      'text-color': p.street_label,
      'text-halo-color': p.street_label_halo,
      'text-halo-width': 1.2,
    },
  },
];

// Highway shields follow the road centerline. Each class gets its own
// colored shield sprite; text-fit expands the sprite to wrap the `ref`
// (e.g., "95", "US 1", "CT 121"). Shields scale with zoom so they stay
// legible on motorways without dominating the view at city scale.
const routeShieldLayers = (): maplibregl.LayerSpecification[] => [
  {
    id: 'route_shield_motorway',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'transportation_name',
    filter: [
      'all',
      ['==', ['get', 'class'], 'motorway'],
      ['has', 'ref'],
    ],
    minzoom: 8,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 280,
      'icon-pitch-alignment': 'viewport',
      'text-pitch-alignment': 'viewport',
      'icon-image': 'shield_interstate',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 1.05, 14, 1.3, 18, 1.55],
      'icon-allow-overlap': true,
      'icon-text-fit': 'both',
      'icon-text-fit-padding': [4, 8, 4, 8],
      'text-field': ['get', 'ref'],
      'text-font': ['Noto Sans Medium'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 8, 11, 14, 13, 18, 16],
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#ffffff' },
  },
  {
    id: 'route_shield_us',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'transportation_name',
    filter: [
      'all',
      ['==', ['get', 'class'], 'trunk'],
      ['has', 'ref'],
    ],
    minzoom: 9,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 280,
      'icon-pitch-alignment': 'viewport',
      'text-pitch-alignment': 'viewport',
      'icon-image': 'shield_us',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 1.0, 14, 1.25, 18, 1.5],
      'icon-allow-overlap': true,
      'icon-text-fit': 'both',
      'icon-text-fit-padding': [4, 8, 4, 8],
      'text-field': ['get', 'ref'],
      'text-font': ['Noto Sans Medium'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 14, 12, 18, 15],
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#1f232b' },
  },
  {
    id: 'route_shield_state',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'transportation_name',
    // Any primary/secondary route carrying a `ref` gets a state shield.
    // Older filter only matched OpenMapTiles' `network='us-state:*'`
    // which planetiler rarely populates — so most state routes lost
    // their badge. Falling back to plain class+ref catches them all.
    filter: [
      'all',
      ['in', ['get', 'class'], ['literal', ['primary', 'secondary']]],
      ['has', 'ref'],
    ],
    minzoom: 10,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 260,
      'icon-pitch-alignment': 'viewport',
      'text-pitch-alignment': 'viewport',
      'icon-image': 'shield_state',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 0.95, 14, 1.2, 18, 1.45],
      'icon-allow-overlap': true,
      'icon-text-fit': 'both',
      'icon-text-fit-padding': [4, 8, 4, 8],
      'text-field': ['get', 'ref'],
      'text-font': ['Noto Sans Medium'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 12, 18, 14],
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#3b3628' },
  },
];

// Place labels staged by class so each level appears at its own zoom
// band — mirrors how Google / Apple Maps decide which name to show.
const placeLabelLayers = (p: Palette): maplibregl.LayerSpecification[] => [
  {
    id: 'place_country',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'place',
    filter: ['==', ['get', 'class'], 'country'],
    minzoom: 1,
    maxzoom: 7,
    layout: {
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 1, 12, 5, 22],
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.15,
    },
    paint: {
      'text-color': p.place_label,
      'text-halo-color': p.place_label_halo,
      'text-halo-width': 1.6,
    },
  },
  {
    id: 'place_state',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'place',
    filter: ['==', ['get', 'class'], 'state'],
    minzoom: 3,
    maxzoom: 9,
    layout: {
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 3, 12, 8, 18],
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.1,
    },
    paint: {
      'text-color': p.place_label,
      'text-halo-color': p.place_label_halo,
      'text-halo-width': 1.5,
    },
  },
  {
    id: 'place_city',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'place',
    filter: ['==', ['get', 'class'], 'city'],
    minzoom: 4,
    layout: {
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 4, 13, 14, 24],
    },
    paint: {
      'text-color': p.place_label,
      'text-halo-color': p.place_label_halo,
      'text-halo-width': 1.5,
    },
  },
  {
    id: 'place_town',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'place',
    filter: ['==', ['get', 'class'], 'town'],
    minzoom: 7,
    layout: {
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 7, 12, 14, 20],
    },
    paint: {
      'text-color': p.place_label,
      'text-halo-color': p.place_label_halo,
      'text-halo-width': 1.3,
    },
  },
  {
    id: 'place_village',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'place',
    filter: ['in', ['get', 'class'], ['literal', ['village', 'hamlet']]],
    minzoom: 10,
    layout: {
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 12, 16, 17],
    },
    paint: {
      'text-color': p.place_label,
      'text-halo-color': p.place_label_halo,
      'text-halo-width': 1.2,
    },
  },
  {
    id: 'place_neighborhood',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'place',
    filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood']]],
    minzoom: 12,
    layout: {
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 12, 16, 15],
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.08,
    },
    paint: {
      'text-color': p.place_label,
      'text-halo-color': p.place_label_halo,
      'text-halo-width': 1,
      'text-opacity': 0.85,
    },
  },
];

const water_and_poi_labels = (p: Palette): maplibregl.LayerSpecification[] => [
  // Water feature names (oceans, lakes, rivers).
  {
    id: 'water_name',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'water_name',
    minzoom: 9,
    layout: {
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 9, 12, 16, 17],
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.1,
      'text-max-width': 8,
    },
    paint: {
      'text-color': p.water_label,
      'text-halo-color': p.water_label_halo,
      'text-halo-width': 1.2,
    },
  },
  {
    id: 'waterway_label',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'waterway',
    filter: ['has', 'name'],
    minzoom: 12,
    layout: {
      'symbol-placement': 'line',
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Italic'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 18, 13],
      'text-letter-spacing': 0.05,
    },
    paint: {
      'text-color': p.water_label,
      'text-halo-color': p.water_label_halo,
      'text-halo-width': 1,
    },
  },
  // House numbers — only at the very closest zooms. Overzoom from z14
  // data is fine here since numbers don't need sub-tile detail. Keep
  // them below POI badges/icons so an address number never replaces
  // the business glyph at the same coordinate.
  {
    id: 'housenumber',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'housenumber',
    minzoom: 17,
    layout: {
      'text-field': ['get', 'housenumber'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 17, 11, 20, 14],
    },
    paint: {
      'text-color': p.housenumber,
      'text-halo-color': p.place_label_halo,
      'text-halo-width': 0.8,
    },
  },
  // Badge container behind the POI icon so businesses read as a marker
  // first and a label second, closer to Tesla / in-car nav styling.
  {
    id: 'poi_badge',
    type: 'circle',
    source: 'protomaps',
    'source-layer': 'poi',
    filter: ['has', 'name'],
    minzoom: 14,
    paint: {
      'circle-pitch-scale': 'viewport',
      'circle-pitch-alignment': 'viewport',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 7.5, 18, 11.5],
      'circle-color': poiMatchExpression(POI_COLOR_BY_KEY, POI_COLORS.default),
      'circle-stroke-color': p.place_label_halo,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14, 1.6, 18, 2.2],
      'circle-opacity': 0.98,
      'circle-blur': 0.05,
    },
  },
  // Points of interest — shops, restaurants, transit stops, etc.
  //
  // Rendered as an in-car style badge: a strong circular marker contains
  // the icon and the business name rides beside it. Collision is set to
  // `allow-overlap` for the icon so pins always appear even when a road
  // label crosses; the text uses `text-optional` so labels drop out of
  // dense clusters before icons do. Requiring `name` hides unnamed clutter.
  {
    id: 'poi_icon',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'poi',
    filter: ['has', 'name'],
    minzoom: 14,
    layout: {
      'icon-image': poiMatchExpression(POI_ICON_BY_KEY, 'default'),
      'icon-pitch-alignment': 'viewport',
      'text-pitch-alignment': 'viewport',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.7, 18, 0.92],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Medium'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 18, 14],
      'text-offset': [1.15, 0],
      'text-anchor': 'left',
      'text-max-width': 9,
      'text-allow-overlap': true,
      'text-optional': true,
      'text-padding': 4,
    },
    paint: {
      'icon-color': p.place_label_halo,
      'icon-halo-color': 'rgba(0, 0, 0, 0)',
      'icon-halo-width': 0,
      'text-color': poiMatchExpression(POI_COLOR_BY_KEY, POI_COLORS.default),
      'text-halo-color': p.place_label_halo,
      'text-halo-width': 2.1,
    },
  },
];

// 3D buildings extrusion.
const buildings3dLayer = (p: Palette): maplibregl.LayerSpecification => ({
  id: 'buildings-3d',
  type: 'fill-extrusion',
  source: 'protomaps',
  'source-layer': 'building',
  minzoom: 13,
  paint: {
    'fill-extrusion-color': [
      'interpolate',
      ['linear'],
      ['coalesce', ['to-number', ['get', 'render_height']], 8],
      8, p.building,
      40, p.building_outline,
      120, '#7d869b',
    ],
    'fill-extrusion-height': [
      'interpolate',
      ['linear'],
      ['zoom'],
      13, 0,
      14, ['coalesce', ['to-number', ['get', 'render_height']], 8],
    ],
    'fill-extrusion-base': [
      'coalesce',
      ['to-number', ['get', 'render_min_height']],
      0,
    ],
    'fill-extrusion-opacity': 0.92,
    'fill-extrusion-vertical-gradient': true,
  },
});

// Flat 2D building footprints for non-3D mode.
const buildings2dLayer = (p: Palette): maplibregl.LayerSpecification => ({
  id: 'buildings-2d',
  type: 'fill',
  source: 'protomaps',
  'source-layer': 'building',
  minzoom: 14,
  paint: {
    'fill-color': p.building,
    'fill-outline-color': p.building_outline,
    'fill-opacity': 0.9,
  },
});

// ── Public builder ────────────────────────────────────────────────

export function buildDarkStyle(
  tileUrl: string,
  overviewUrl: string,
  labelsUrl: string,
  opts: DarkStyleOptions = {},
): maplibregl.StyleSpecification {
  const mode: LayerMode = opts.mode ?? 'map';
  const p = opts.palette ?? DARK;

  const sources: maplibregl.StyleSpecification['sources'] = {
    protomaps: {
      type: 'vector',
      url: tileUrl,
      attribution:
        '© <a href="https://openstreetmap.org">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
    },
    world_overview: {
      type: 'vector',
      url: overviewUrl,
      attribution:
        '© <a href="https://naturalearthdata.com">Natural Earth</a>',
    },
    world_labels: {
      type: 'geojson',
      data: labelsUrl,
      attribution:
        '© <a href="https://naturalearthdata.com">Natural Earth</a>',
    },
  };

  // Layer order matters — MapLibre paints bottom-up. World-overview
  // fills + boundaries paint UNDER the per-region source so region
  // tiles fully cover them at street zoom; world-overview labels
  // paint alongside region place labels (both maxzoom-gated so they
  // hand off cleanly).
  // In 3D mode, buildings paint AFTER roads so extrusions occlude the
  // road lines passing under them (roads going "through" buildings was
  // the flat-2D-style ordering leaking into the 3D view). Flat 2D mode
  // keeps buildings under roads so footprints don't hide the road grid.
  const buildings2d = buildings2dLayer(p);
  const buildings3d = buildings3dLayer(p);
  const layers: maplibregl.LayerSpecification[] = [
    { id: 'bg', type: 'background', paint: { 'background-color': p.background } },
    ...worldOverviewFillLayers(p),
    ...fillLayers(p),
    ...worldOverviewBoundaryLayers(p),
    ...worldOverviewAdmin1BoundaryLayers(p),
    ...worldOverviewAdmin1LabelLayers(p),
    ...boundaryLayers(p),
    ...(mode === '3d' ? [] : [buildings2d]),
    ...roadLayers(p),
    ...(mode === '3d' ? [buildings3d] : []),
    ...water_and_poi_labels(p),
    ...transportationNameLayers(p),
    ...routeShieldLayers(),
    ...worldOverviewPlaceLayers(p),
    ...placeLabelLayers(p),
  ];

  return {
    version: 8,
    glyphs: '/api/v1/maps/glyphs/{fontstack}/{range}.pbf',
    sources,
    layers,
  };
}

export default buildDarkStyle;
