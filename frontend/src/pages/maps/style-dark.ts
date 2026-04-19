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

export type LayerMode = 'map' | '3d';
export type ColorTheme = 'dark' | 'light';

interface Palette {
  background: string;
  water: string;
  park: string;
  residential: string;
  road_minor: string;
  road_medium: string;
  road_major: string;
  road_casing: string;
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
  water: '#16304d',
  park: '#1b2d1e',
  residential: '#1e2128',
  road_minor: '#5a6578',
  road_medium: '#8892ab',
  road_major: '#b5bed4',
  road_casing: '#0a0c10',
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

const LIGHT: Palette = {
  background: '#f3f1ea',
  water: '#a8cfe8',
  park: '#c8e0c4',
  residential: '#ebe8e0',
  road_minor: '#ffffff',
  road_medium: '#fff8d4',
  road_major: '#ffd96d',
  road_casing: '#c0b9a8',
  building: '#e3ddcb',
  building_outline: '#c9c2ac',
  boundary_country: '#7c5aa6',
  boundary_state: '#aa92c8',
  place_label: '#1a1d22',
  place_label_halo: '#ffffff',
  street_label: '#2a2e38',
  street_label_halo: '#ffffff',
  water_label: '#3c6a9a',
  water_label_halo: '#ffffff',
  poi_label: '#54595f',
  housenumber: '#6a7080',
};

const PALETTES: Record<ColorTheme, Palette> = { dark: DARK, light: LIGHT };

export interface DarkStyleOptions {
  mode?: LayerMode;
  theme?: ColorTheme;
}

// ── Layer builders ────────────────────────────────────────────────

const fillLayers = (p: Palette): maplibregl.LayerSpecification[] => [
  // Parks & greenspace.
  {
    id: 'park',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'park',
    paint: { 'fill-color': p.park, 'fill-opacity': 0.8 },
  },
  // Residential/urban fill.
  {
    id: 'landuse_residential',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'landuse',
    filter: ['==', ['get', 'class'], 'residential'],
    paint: { 'fill-color': p.residential, 'fill-opacity': 0.7 },
  },
  // Additional greenspace from landcover.
  {
    id: 'landcover_green',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'landcover',
    filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass', 'farmland']]],
    paint: { 'fill-color': p.park, 'fill-opacity': 0.5 },
  },
  // Water polygons.
  {
    id: 'water',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'water',
    paint: { 'fill-color': p.water },
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
      'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1.2, 18, 11],
      'line-opacity': 0.6,
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
    filter: ['in', ['get', 'class'], ['literal', ['minor', 'service']]],
    minzoom: 10,
    paint: {
      'line-color': p.road_minor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.3, 18, 4],
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
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 18, 7],
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
      'line-color': p.road_major,
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.8, 18, 9],
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
// ``labelrank`` columns — the filters below stage labels across z0–z7.
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
    maxzoom: 7,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 5, 20],
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.15,
      'text-max-width': 9,
      'text-padding': 2,
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
    maxzoom: 7,
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 7, 15],
      'text-transform': 'uppercase',
      'text-letter-spacing': 0.1,
      'text-max-width': 8,
      'text-padding': 2,
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
    minzoom: 10,
    layout: {
      'symbol-placement': 'line',
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 12, 18, 18],
      'text-letter-spacing': 0.05,
      'text-max-angle': 30,
    },
    paint: {
      'text-color': p.street_label,
      'text-halo-color': p.street_label_halo,
      'text-halo-width': 1.4,
    },
  },
  {
    id: 'street_label_medium',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'transportation_name',
    filter: ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary']]],
    minzoom: 12,
    layout: {
      'symbol-placement': 'line',
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 18, 16],
      'text-letter-spacing': 0.03,
      'text-max-angle': 30,
    },
    paint: {
      'text-color': p.street_label,
      'text-halo-color': p.street_label_halo,
      'text-halo-width': 1.2,
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
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 11, 18, 15],
      'text-max-angle': 30,
    },
    paint: {
      'text-color': p.street_label,
      'text-halo-color': p.street_label_halo,
      'text-halo-width': 1,
    },
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
  // Points of interest — shops, restaurants, transit stops, etc.
  {
    id: 'poi',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'poi',
    minzoom: 14,
    layout: {
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 14, 12, 18, 15],
      'text-offset': [0, 0.8],
      'text-anchor': 'top',
      'text-max-width': 8,
    },
    paint: {
      'text-color': p.poi_label,
      'text-halo-color': p.place_label_halo,
      'text-halo-width': 1,
    },
  },
  // House numbers — only at the very closest zooms. Overzoom from z14
  // data is fine here since numbers don't need sub-tile detail.
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
];

// 3D buildings extrusion.
const buildings3dLayer = (p: Palette): maplibregl.LayerSpecification => ({
  id: 'buildings-3d',
  type: 'fill-extrusion',
  source: 'protomaps',
  'source-layer': 'building',
  minzoom: 13,
  paint: {
    'fill-extrusion-color': p.building,
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
    'fill-extrusion-opacity': 0.85,
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
  const theme: ColorTheme = opts.theme ?? 'dark';
  const p = PALETTES[theme];

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
  const layers: maplibregl.LayerSpecification[] = [
    { id: 'bg', type: 'background', paint: { 'background-color': p.background } },
    ...worldOverviewFillLayers(p),
    ...fillLayers(p),
    ...worldOverviewBoundaryLayers(p),
    ...boundaryLayers(p),
    ...(mode === '3d' ? [buildings3dLayer(p)] : [buildings2dLayer(p)]),
    ...roadLayers(p),
    ...transportationNameLayers(p),
    ...water_and_poi_labels(p),
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
