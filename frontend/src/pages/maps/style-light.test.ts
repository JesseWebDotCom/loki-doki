import { describe, expect, it } from 'vitest';
import { buildDarkStyle } from './style-dark';
import { buildLightStyle } from './style-light';

const TILE_URL = 'pmtiles:///maps/regions/us-ct/streets.pmtiles';
const OVERVIEW_URL = 'pmtiles:///api/v1/maps/tiles/_overview/streets.pmtiles';
const LABELS_URL = '/api/v1/maps/tiles/_overview/labels.geojson';

function parseHex(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('buildLightStyle', () => {
  it('ships the same landuse tint layers in light mode', () => {
    const style = buildLightStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const ids = style.layers.map((layer) => layer.id);
    expect(ids).toContain('landuse_park');
    expect(ids).toContain('landuse_wood');
    expect(ids).toContain('landuse_residential');
    expect(ids).toContain('landuse_commercial');
    expect(ids).toContain('landuse_industrial');
  });

  it('uses a brighter water fill than the dark theme', () => {
    const dark = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const light = buildLightStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const waterOf = (style: typeof dark) =>
      (style.layers.find((layer) => layer.id === 'water') as {
        paint: { 'fill-color': string };
      }).paint['fill-color'];
    expect(luminance(waterOf(light))).toBeGreaterThan(luminance(waterOf(dark)));
  });
});
