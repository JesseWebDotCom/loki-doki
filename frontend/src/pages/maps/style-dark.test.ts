import { describe, expect, it } from 'vitest';
import { buildDarkStyle } from './style-dark';

const TILE_URL = 'pmtiles:///maps/regions/us-ct/streets.pmtiles';
const OVERVIEW_URL = 'pmtiles:///api/v1/maps/tiles/_overview/streets.pmtiles';
const LABELS_URL = '/api/v1/maps/tiles/_overview/labels.geojson';

describe('buildDarkStyle', () => {
  it('omits the 3D-buildings extrusion layer in flat map mode (default)', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const extrusion = style.layers.find((l) => l.id === 'buildings-3d');
    expect(extrusion).toBeUndefined();
  });

  it('omits the extrusion layer when mode is explicitly "map"', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL, { mode: 'map' });
    expect(style.layers.find((l) => l.id === 'buildings-3d')).toBeUndefined();
  });

  it('adds a fill-extrusion layer against the OpenMapTiles building source-layer in 3D mode', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL, { mode: '3d' });
    const extrusion = style.layers.find((l) => l.id === 'buildings-3d');
    expect(extrusion).toBeDefined();
    expect(extrusion?.type).toBe('fill-extrusion');
    expect((extrusion as { source: string }).source).toBe('protomaps');
    // planetiler + OpenMapTiles use singular ``building``, not the
    // Protomaps-basemap plural ``buildings``.
    expect((extrusion as { 'source-layer': string })['source-layer']).toBe(
      'building',
    );
  });

  it('extrusion reads render_height / render_min_height (OpenMapTiles pre-resolves OSM height)', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL, { mode: '3d' });
    const extrusion = style.layers.find((l) => l.id === 'buildings-3d') as
      | { paint: Record<string, unknown> }
      | undefined;
    const heightExpr = JSON.stringify(extrusion?.paint['fill-extrusion-height']);
    expect(heightExpr).toContain('render_height');
    const baseExpr = JSON.stringify(extrusion?.paint['fill-extrusion-base']);
    expect(baseExpr).toContain('render_min_height');
  });

  it('places the extrusion layer before the place-labels so labels stay on top', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL, { mode: '3d' });
    const ids = style.layers.map((l) => l.id);
    const extrusionIdx = ids.indexOf('buildings-3d');
    // Place labels are split per class (country/state/city/town/...); pick
    // any one and confirm the extrusion paints underneath it.
    const cityIdx = ids.indexOf('place_city');
    expect(extrusionIdx).toBeGreaterThan(-1);
    expect(cityIdx).toBeGreaterThan(-1);
    expect(extrusionIdx).toBeLessThan(cityIdx);
  });

  it('includes street-name labels on transportation_name source-layer', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const streetLabels = style.layers.filter(
      (l) => (l as { 'source-layer'?: string })['source-layer'] === 'transportation_name',
    );
    expect(streetLabels.length).toBeGreaterThan(0);
    for (const l of streetLabels) {
      expect(l.type).toBe('symbol');
      expect((l as { layout: { 'symbol-placement'?: string } }).layout['symbol-placement']).toBe('line');
    }
  });

  it('includes a housenumber layer gated to close zoom', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const hn = style.layers.find((l) => l.id === 'housenumber');
    expect(hn).toBeDefined();
    expect((hn as { 'source-layer': string })['source-layer']).toBe('housenumber');
    expect((hn as { minzoom?: number }).minzoom ?? 0).toBeGreaterThanOrEqual(16);
  });

  it('uses the supplied tile URL on the protomaps vector source', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL, { mode: '3d' });
    const src = style.sources.protomaps as { type: string; url: string };
    expect(src.type).toBe('vector');
    expect(src.url).toBe(TILE_URL);
  });

  it('references OpenMapTiles source layers (not Protomaps basemap schema)', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const sourceLayers = new Set(
      style.layers
        .map((l) => (l as { 'source-layer'?: string })['source-layer'])
        .filter((x): x is string => typeof x === 'string'),
    );
    // Must target OpenMapTiles names so planetiler-produced tiles render.
    expect(sourceLayers.has('transportation')).toBe(true);
    expect(sourceLayers.has('boundary')).toBe(true);
    expect(sourceLayers.has('place')).toBe(true);
    expect(sourceLayers.has('water')).toBe(true);
    // Protomaps-basemap layer names must not leak back in.
    expect(sourceLayers.has('roads')).toBe(false);
    expect(sourceLayers.has('boundaries')).toBe(false);
    expect(sourceLayers.has('places')).toBe(false);
    expect(sourceLayers.has('buildings')).toBe(false);
  });

  it('swaps the palette between dark and light themes', () => {
    const dark = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL, { theme: 'dark' });
    const light = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL, { theme: 'light' });
    const bgOf = (s: typeof dark) =>
      (s.layers.find((l) => l.id === 'bg') as {
        paint: { 'background-color': string };
      }).paint['background-color'];
    expect(bgOf(dark)).not.toBe(bgOf(light));
  });

  // ── Dual-source / world overview assertions ─────────────────────

  it('declares protomaps, world_overview, and world_labels as sources', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    expect(Object.keys(style.sources).sort()).toEqual(
      ['protomaps', 'world_labels', 'world_overview'].sort(),
    );
    const overview = style.sources.world_overview as { type: string; url: string };
    expect(overview.type).toBe('vector');
    expect(overview.url).toBe(OVERVIEW_URL);
  });

  it('world_labels is a geojson source backed by the supplied URL', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const labels = style.sources.world_labels as { type: string; data: string };
    expect(labels.type).toBe('geojson');
    expect(labels.data).toBe(LABELS_URL);
  });

  it('gates every world-overview (pmtiles-backed) layer to maxzoom 7', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const overviewLayers = style.layers.filter(
      (l) => (l as { source?: string }).source === 'world_overview',
    );
    // Four pmtiles-backed layers (two fills + two boundaries); the two
    // country/state label layers have moved to the world_labels source.
    expect(overviewLayers.length).toBe(4);
    for (const l of overviewLayers) {
      expect((l as { maxzoom?: number }).maxzoom).toBe(7);
    }
  });

  it('country + state label layers read from world_labels and gate on kind', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const country = style.layers.find((l) => l.id === 'world_place_country');
    const state = style.layers.find((l) => l.id === 'world_place_state');
    expect(country).toBeDefined();
    expect(state).toBeDefined();
    expect((country as { source: string }).source).toBe('world_labels');
    expect((state as { source: string }).source).toBe('world_labels');
    // Filter must key on the ``kind`` property we write into every
    // feature in the NE-backed geojson.
    expect(JSON.stringify((country as { filter: unknown }).filter)).toContain('country');
    expect(JSON.stringify((state as { filter: unknown }).filter)).toContain('state');
  });

  it('keeps world place labels visible at all zooms', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const country = style.layers.find((l) => l.id === 'world_place_country');
    const state = style.layers.find((l) => l.id === 'world_place_state');
    expect(country).toBeDefined();
    expect(state).toBeDefined();
    expect((country as { maxzoom?: number }).maxzoom).toBeUndefined();
    expect((state as { maxzoom?: number }).maxzoom).toBeUndefined();
  });

  it('paints world-overview fills beneath the per-region fills', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const ids = style.layers.map((l) => l.id);
    const worldWaterIdx = ids.indexOf('world_water');
    const regionWaterIdx = ids.indexOf('water');
    expect(worldWaterIdx).toBeGreaterThan(-1);
    expect(regionWaterIdx).toBeGreaterThan(-1);
    expect(worldWaterIdx).toBeLessThan(regionWaterIdx);
  });
});
