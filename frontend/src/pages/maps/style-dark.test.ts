import { describe, expect, it } from 'vitest';
import { buildDarkStyle } from './style-dark';

const TILE_URL = 'pmtiles:///maps/regions/us-ct/streets.pmtiles';

describe('buildDarkStyle', () => {
  it('omits the 3D-buildings extrusion layer in flat map mode (default)', () => {
    const style = buildDarkStyle(TILE_URL);
    const extrusion = style.layers.find((l) => l.id === 'buildings-3d');
    expect(extrusion).toBeUndefined();
  });

  it('omits the extrusion layer when mode is explicitly "map"', () => {
    const style = buildDarkStyle(TILE_URL, { mode: 'map' });
    expect(style.layers.find((l) => l.id === 'buildings-3d')).toBeUndefined();
  });

  it('adds a fill-extrusion layer against the OpenMapTiles building source-layer in 3D mode', () => {
    const style = buildDarkStyle(TILE_URL, { mode: '3d' });
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
    const style = buildDarkStyle(TILE_URL, { mode: '3d' });
    const extrusion = style.layers.find((l) => l.id === 'buildings-3d') as
      | { paint: Record<string, unknown> }
      | undefined;
    const heightExpr = JSON.stringify(extrusion?.paint['fill-extrusion-height']);
    expect(heightExpr).toContain('render_height');
    const baseExpr = JSON.stringify(extrusion?.paint['fill-extrusion-base']);
    expect(baseExpr).toContain('render_min_height');
  });

  it('places the extrusion layer before the place-labels so labels stay on top', () => {
    const style = buildDarkStyle(TILE_URL, { mode: '3d' });
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
    const style = buildDarkStyle(TILE_URL);
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
    const style = buildDarkStyle(TILE_URL);
    const hn = style.layers.find((l) => l.id === 'housenumber');
    expect(hn).toBeDefined();
    expect((hn as { 'source-layer': string })['source-layer']).toBe('housenumber');
    expect((hn as { minzoom?: number }).minzoom ?? 0).toBeGreaterThanOrEqual(16);
  });

  it('uses the supplied tile URL on the protomaps vector source', () => {
    const style = buildDarkStyle(TILE_URL, { mode: '3d' });
    const src = style.sources.protomaps as { type: string; url: string };
    expect(src.type).toBe('vector');
    expect(src.url).toBe(TILE_URL);
  });

  it('references OpenMapTiles source layers (not Protomaps basemap schema)', () => {
    const style = buildDarkStyle(TILE_URL);
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
    const dark = buildDarkStyle(TILE_URL, { theme: 'dark' });
    const light = buildDarkStyle(TILE_URL, { theme: 'light' });
    const bgOf = (s: typeof dark) =>
      (s.layers.find((l) => l.id === 'bg') as {
        paint: { 'background-color': string };
      }).paint['background-color'];
    expect(bgOf(dark)).not.toBe(bgOf(light));
  });
});
