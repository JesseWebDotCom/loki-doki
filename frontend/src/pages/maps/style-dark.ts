/**
 * Protomaps dark basemap style for MapLibre GL.
 *
 * Emits a minimal vector style pointed at a single `pmtiles://…` source.
 * Colors borrow the Onyx elevation + purple-accent palette used
 * throughout the app so the map blends with the surrounding UI.
 *
 * The `tileUrl` string must already carry the `pmtiles://` prefix — the
 * caller is responsible for the choice between the online Protomaps
 * demo and a locally-served region file. This module does not know
 * which is live.
 */
import type maplibregl from 'maplibre-gl';

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
} as const;

/**
 * Build a MapLibre style document backed by a single pmtiles source.
 *
 * @param tileUrl  Either `pmtiles://https://…` (online demo) or
 *                 `pmtiles:///api/v1/maps/tiles/<region>.pmtiles` once
 *                 Chunk 2 lands.
 */
export function buildDarkStyle(tileUrl: string): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sources: {
      protomaps: {
        type: 'vector',
        url: tileUrl,
        attribution:
          '© <a href="https://openstreetmap.org">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': COLOR.earth } },
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
        paint: { 'line-color': COLOR.road_minor, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.3, 18, 2] },
      },
      {
        id: 'roads_medium',
        type: 'line',
        source: 'protomaps',
        'source-layer': 'roads',
        filter: ['==', 'kind', 'medium_road'],
        paint: { 'line-color': COLOR.road_medium, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 18, 4] },
      },
      {
        id: 'roads_major',
        type: 'line',
        source: 'protomaps',
        'source-layer': 'roads',
        filter: ['in', 'kind', 'major_road', 'highway'],
        paint: { 'line-color': COLOR.road_major, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 18, 6] },
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
          'text-halo-color': COLOR.place_label_halo,
          'text-halo-width': 1.2,
        },
      },
    ],
  };
}
