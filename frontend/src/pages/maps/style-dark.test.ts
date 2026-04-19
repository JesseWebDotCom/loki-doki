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

  it('adds a fill-extrusion layer for the buildings source-layer in 3D mode', () => {
    const style = buildDarkStyle(TILE_URL, { mode: '3d' });
    const extrusion = style.layers.find((l) => l.id === 'buildings-3d');
    expect(extrusion).toBeDefined();
    expect(extrusion?.type).toBe('fill-extrusion');
    // Reads building attributes from the local PMTiles source-layer.
    expect((extrusion as { source: string }).source).toBe('protomaps');
    expect((extrusion as { 'source-layer': string })['source-layer']).toBe(
      'buildings',
    );
  });

  it('extrusion paint resolves height from height, then building:levels, then fallback', () => {
    const style = buildDarkStyle(TILE_URL, { mode: '3d' });
    const extrusion = style.layers.find((l) => l.id === 'buildings-3d') as
      | { paint: Record<string, unknown> }
      | undefined;
    const heightExpr = JSON.stringify(extrusion?.paint['fill-extrusion-height']);
    expect(heightExpr).toContain('height');
    expect(heightExpr).toContain('building:levels');
    const baseExpr = JSON.stringify(extrusion?.paint['fill-extrusion-base']);
    expect(baseExpr).toContain('min_height');
  });

  it('places the extrusion layer before the place-labels layer so labels stay on top', () => {
    const style = buildDarkStyle(TILE_URL, { mode: '3d' });
    const ids = style.layers.map((l) => l.id);
    const extrusionIdx = ids.indexOf('buildings-3d');
    const placesIdx = ids.indexOf('places');
    expect(extrusionIdx).toBeGreaterThan(-1);
    expect(placesIdx).toBeGreaterThan(-1);
    expect(extrusionIdx).toBeLessThan(placesIdx);
  });

  it('uses the supplied tile URL on the protomaps vector source', () => {
    const style = buildDarkStyle(TILE_URL, { mode: '3d' });
    const src = style.sources.protomaps as { type: string; url: string };
    expect(src.type).toBe('vector');
    expect(src.url).toBe(TILE_URL);
  });
});
