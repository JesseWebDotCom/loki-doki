/**
 * Protomaps dark basemap style for MapLibre GL.
 *
 * Chunk 3 extends the Chunk 1 vector-only style with an optional raster
 * satellite source and three rendering modes:
 *
 *  - ``map``       — the Protomaps vector basemap (default).
 *  - ``satellite`` — Esri-compatible raster imagery only.
 *  - ``hybrid``    — satellite imagery with place labels + boundary
 *                    lines from the vector style painted on top.
 *
 * The ``tileUrl`` string must already carry the ``pmtiles://`` prefix —
 * the caller picks between the online Protomaps demo and a locally
 * served region file. Satellite templates follow MapLibre's
 * ``{z}/{x}/{y}`` convention and are passed through verbatim.
 */
import type maplibregl from 'maplibre-gl';

export type LayerMode = 'map' | 'satellite' | 'hybrid';

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
  place_label_halo_bright: '#000000', // stronger halo over imagery
} as const;

export interface DarkStyleOptions {
  mode?: LayerMode;
  /** MapLibre raster URL template, e.g. ``/api/v1/maps/tiles/us-ct/sat/{z}/{x}/{y}.jpg``. */
  satelliteUrlTemplate?: string | null;
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

const satelliteRasterLayer = (): maplibregl.LayerSpecification => ({
  id: 'satellite',
  type: 'raster',
  source: 'satellite',
  paint: { 'raster-opacity': 1.0 },
});

// ── Public builder ────────────────────────────────────────────────

/**
 * Build a MapLibre style document.
 *
 * @param tileUrl The pmtiles URL to use for the vector source. May be
 *                the online Protomaps demo or a backend sendfile route.
 * @param opts    Mode + optional satellite template. When omitted the
 *                style matches the Chunk-1 vector-only output.
 */
export function buildDarkStyle(
  tileUrl: string,
  opts: DarkStyleOptions = {},
): maplibregl.StyleSpecification {
  const mode: LayerMode = opts.mode ?? 'map';
  const hasSatellite = Boolean(opts.satelliteUrlTemplate);
  const effectiveMode: LayerMode = hasSatellite ? mode : 'map';

  const sources: maplibregl.StyleSpecification['sources'] = {
    protomaps: {
      type: 'vector',
      url: tileUrl,
      attribution:
        '© <a href="https://openstreetmap.org">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
    },
  };

  if (hasSatellite) {
    sources.satellite = {
      type: 'raster',
      tiles: [opts.satelliteUrlTemplate as string],
      tileSize: 256,
      attribution: '© Esri World Imagery',
    };
  }

  const layers: maplibregl.LayerSpecification[] = [
    {
      id: 'bg',
      type: 'background',
      paint: {
        'background-color':
          effectiveMode === 'satellite' || effectiveMode === 'hybrid'
            ? '#000'
            : COLOR.earth,
      },
    },
  ];

  if (effectiveMode === 'satellite') {
    layers.push(satelliteRasterLayer());
  } else if (effectiveMode === 'hybrid') {
    layers.push(satelliteRasterLayer());
    // Only the subset of vector layers that read well on top of
    // imagery — boundaries + place labels. Full road/earth fills would
    // obscure the photography.
    const overlay = vectorLayers(COLOR.place_label_halo_bright).filter(
      (l) => l.id === 'boundaries' || l.id === 'places',
    );
    layers.push(...overlay);
  } else {
    layers.push(...vectorLayers(COLOR.place_label_halo));
  }

  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sources,
    layers,
  };
}
