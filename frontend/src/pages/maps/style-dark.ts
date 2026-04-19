/**
 * Protomaps dark basemap style for MapLibre GL.
 *
 * Two modes:
 *  - ``map`` (default): classic flat vector basemap.
 *  - ``3d``: everything from ``map`` plus a ``fill-extrusion`` layer
 *    that renders OSM ``building=*`` features from the vector tiles
 *    we build locally (chunk 3 preserves ``height`` /
 *    ``building:levels`` / ``min_height`` attributes). No extra
 *    downloads — the extrusion paint reads attributes already in the
 *    installed PMTiles.
 *
 * The ``tileUrl`` string must already carry the ``pmtiles://`` prefix —
 * the caller picks between the online Protomaps demo and a locally
 * served region file.
 */
import type maplibregl from 'maplibre-gl';

export type LayerMode = 'map' | '3d';

// Onyx palette (mirrors the CSS tokens --elevation-1..4 and the
// purple accent). Kept as string literals here instead of reading from
// CSS custom properties because MapLibre's style spec expects plain
// hex / hsl strings and resolving `var(--…)` at runtime would require
// a second paint after getComputedStyle — not worth the complexity.
const COLOR = {
  earth: '#14161c',       // base land fill — matches --elevation-1
  water: '#0b1220',       // rivers, lakes, ocean
  park: '#18221a',        // greenspace — subtle tint above earth
  road_minor: '#262a33',  // tertiary/residential
  road_medium: '#313744', // secondary/primary
  road_major: '#3d4660',  // motorways/trunks
  boundary: '#4a3a6a',    // purple accent for admin borders
  place_label: '#d7dae3',
  place_label_halo: '#14161c',
  building: '#3a3f4a',    // extrusion fill for the 3D buildings layer
} as const;

export interface DarkStyleOptions {
  mode?: LayerMode;
}

// Layer-builder helpers ───────────────────────────────────────────

const vectorLayers = (
  haloColor: string,
): maplibregl.LayerSpecification[] => [
  {
    id: 'earth',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'earth',
    paint: { 'fill-color': COLOR.earth },
  },
  {
    id: 'landuse_park',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'landuse',
    filter: ['in', 'kind', 'park', 'forest', 'nature_reserve', 'wood'],
    paint: { 'fill-color': COLOR.park, 'fill-opacity': 0.6 },
  },
  {
    id: 'water',
    type: 'fill',
    source: 'protomaps',
    'source-layer': 'water',
    paint: { 'fill-color': COLOR.water },
  },
  {
    id: 'roads_minor',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'roads',
    filter: ['in', 'kind', 'minor_road', 'path'],
    minzoom: 12,
    paint: {
      'line-color': COLOR.road_minor,
      'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.3, 18, 2],
    },
  },
  {
    id: 'roads_medium',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'roads',
    filter: ['==', 'kind', 'medium_road'],
    paint: {
      'line-color': COLOR.road_medium,
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 18, 4],
    },
  },
  {
    id: 'roads_major',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'roads',
    filter: ['in', 'kind', 'major_road', 'highway'],
    paint: {
      'line-color': COLOR.road_major,
      'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 18, 6],
    },
  },
  {
    id: 'boundaries',
    type: 'line',
    source: 'protomaps',
    'source-layer': 'boundaries',
    paint: {
      'line-color': COLOR.boundary,
      'line-width': 0.6,
      'line-dasharray': [2, 2],
    },
  },
  {
    id: 'places',
    type: 'symbol',
    source: 'protomaps',
    'source-layer': 'places',
    filter: ['in', 'kind', 'country', 'state', 'city', 'town', 'village', 'locality', 'neighbourhood'],
    layout: {
      'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 10, 14],
      'text-anchor': 'center',
    },
    paint: {
      'text-color': COLOR.place_label,
      'text-halo-color': haloColor,
      'text-halo-width': 1.4,
    },
  },
];

// The 3D buildings extrusion layer. Height resolves from the first
// available OSM tag: explicit ``height`` (metres), then ``building:levels``
// × 3 m per storey, then a conservative 8 m fallback. ``min_height``
// lifts sections that sit on top of another structure (rooftop plant,
// elevated walkways). Inserted after the road lines but before place
// labels so labels stay readable when tilted.
const buildings3dLayer = (): maplibregl.LayerSpecification => ({
  id: 'buildings-3d',
  type: 'fill-extrusion',
  source: 'protomaps',
  'source-layer': 'buildings',
  minzoom: 13,
  paint: {
    'fill-extrusion-color': COLOR.building,
    'fill-extrusion-height': [
      'interpolate',
      ['linear'],
      ['zoom'],
      13, 0,
      14, [
        'coalesce',
        ['to-number', ['get', 'height']],
        ['*', ['to-number', ['get', 'building:levels']], 3],
        8,
      ],
    ],
    'fill-extrusion-base': [
      'coalesce',
      ['to-number', ['get', 'min_height']],
      0,
    ],
    'fill-extrusion-opacity': 0.85,
  },
});

// ── Public builder ────────────────────────────────────────────────

/**
 * Build a MapLibre style document.
 *
 * @param tileUrl The pmtiles URL to use for the vector source. May be
 *                the online Protomaps demo or a backend sendfile route.
 * @param opts    Style options — currently only ``mode`` to switch
 *                between the flat map and the 3D-buildings view.
 */
export function buildDarkStyle(
  tileUrl: string,
  opts: DarkStyleOptions = {},
): maplibregl.StyleSpecification {
  const mode: LayerMode = opts.mode ?? 'map';

  const sources: maplibregl.StyleSpecification['sources'] = {
    protomaps: {
      type: 'vector',
      url: tileUrl,
      attribution:
        '© <a href="https://openstreetmap.org">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
    },
  };

  const base = vectorLayers(COLOR.place_label_halo);
  // Splice the extrusion layer in after the roads/boundaries but
  // before the place-label symbols (last entry in vectorLayers).
  const placesIdx = base.findIndex((l) => l.id === 'places');
  const layersBeforePlaces = placesIdx === -1 ? base : base.slice(0, placesIdx);
  const layersPlaces = placesIdx === -1 ? [] : base.slice(placesIdx);

  const layers: maplibregl.LayerSpecification[] = [
    {
      id: 'bg',
      type: 'background',
      paint: { 'background-color': COLOR.earth },
    },
    ...layersBeforePlaces,
    ...(mode === '3d' ? [buildings3dLayer()] : []),
    ...layersPlaces,
  ];

  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sources,
    layers,
  };
}
