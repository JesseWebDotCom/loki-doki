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

  it('keeps POI badges above the 3D extrusion layer', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL, { mode: '3d' });
    const ids = style.layers.map((l) => l.id);
    const extrusionIdx = ids.indexOf('buildings-3d');
    const poiBadgeIdx = ids.indexOf('poi_badge');
    const poiIconIdx = ids.indexOf('poi_icon');
    expect(extrusionIdx).toBeGreaterThan(-1);
    expect(poiBadgeIdx).toBeGreaterThan(extrusionIdx);
    expect(poiIconIdx).toBeGreaterThan(extrusionIdx);
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

  it('renders interstate shields above motorways', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const shields = style.layers.filter((l) => /^route_shield_/.test(l.id));
    expect(shields.length).toBeGreaterThan(0);
    for (const layer of shields) {
      expect((layer as { 'source-layer': string })['source-layer']).toBe('transportation_name');
      expect(layer.type).toBe('symbol');
      expect(
        (layer as { layout: { 'text-font': string[] } }).layout['text-font'],
      ).toEqual(['Noto Sans Medium']);
      expect(
        (layer as { layout: { 'icon-pitch-alignment'?: string } }).layout['icon-pitch-alignment'],
      ).toBe('viewport');
      expect(
        (layer as { layout: { 'icon-allow-overlap'?: boolean } }).layout['icon-allow-overlap'],
      ).toBe(true);
    }
  });

  it('renders waterway names along stream lines', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const waterway = style.layers.find((l) => l.id === 'waterway_label') as
      | { layout: { 'symbol-placement': string } }
      | undefined;
    expect(waterway).toBeDefined();
    expect(waterway?.layout['symbol-placement']).toBe('line');
  });

  it('motorway lines are brighter than residential', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const motorway = style.layers.find((l) => l.id === 'roads_major') as
      | { paint: { 'line-color': string } }
      | undefined;
    const residential = style.layers.find((l) => l.id === 'roads_minor') as
      | { paint: { 'line-color': string } }
      | undefined;
    expect(motorway).toBeDefined();
    expect(residential).toBeDefined();
    expect(JSON.stringify(motorway?.paint['line-color'])).toContain('#1c6ff2');
    expect(luminance(residential?.paint['line-color'] ?? '#000000')).toBeLessThan(
      luminance('#1c6ff2'),
    );
  });

  it('includes a housenumber layer gated to close zoom', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const hn = style.layers.find((l) => l.id === 'housenumber');
    expect(hn).toBeDefined();
    expect((hn as { 'source-layer': string })['source-layer']).toBe('housenumber');
    expect((hn as { minzoom?: number }).minzoom ?? 0).toBeGreaterThanOrEqual(16);
  });

  it('renders POIs with a badge container plus grouped icon + label', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const poiBadge = style.layers.find((l) => l.id === 'poi_badge') as
      | { paint: Record<string, unknown>; filter?: unknown[] }
      | undefined;
    const poiIcon = style.layers.find((l) => l.id === 'poi_icon') as
      | { filter?: unknown[]; layout: Record<string, unknown>; paint: Record<string, unknown> }
      | undefined;
    expect(poiBadge).toBeDefined();
    expect(JSON.stringify(poiBadge?.paint['circle-color'])).toContain('#f59e0b');
    expect(poiBadge?.paint['circle-pitch-alignment']).toBe('viewport');
    expect(JSON.stringify(poiBadge?.filter)).toContain('name');
    expect(poiIcon).toBeDefined();
    // Icon image pulls from the category-mapped expression.
    expect(JSON.stringify(poiIcon?.layout['icon-image'])).toContain('fast_food');
    // Label is on the same layer so collision keeps icon+text grouped.
    expect(poiIcon?.paint['icon-color']).toBe('#0a0c10');
    expect(poiIcon?.layout['icon-pitch-alignment']).toBe('viewport');
    expect(poiIcon?.layout['text-anchor']).toBe('left');
    expect(JSON.stringify(poiIcon?.layout['text-offset'])).toContain('1.15');
    expect(JSON.stringify(poiIcon?.layout['text-field'])).toContain('name');
    // Icons must always paint even when a road label crosses them.
    expect(poiIcon?.layout['icon-allow-overlap']).toBe(true);
    expect(poiIcon?.layout['icon-ignore-placement']).toBe(true);
    // Only named POIs render — unnamed clutter is hidden.
    expect(JSON.stringify(poiIcon?.filter)).toContain('name');
  });

  it('colors major highways more strongly than local streets', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const motorway = style.layers.find((l) => l.id === 'roads_major') as
      | { paint: { 'line-color': unknown } }
      | undefined;
    const primary = style.layers.find((l) => l.id === 'roads_medium_colored') as
      | { paint: { 'line-color': unknown } }
      | undefined;
    expect(JSON.stringify(motorway?.paint['line-color'])).toContain('#1c6ff2');
    expect(JSON.stringify(primary?.paint['line-color'])).toContain('#f1b45a');
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
    const dark = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const light = buildLightStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const bgOf = (s: typeof dark) =>
      (s.layers.find((l) => l.id === 'bg') as {
        paint: { 'background-color': string };
      }).paint['background-color'];
    expect(bgOf(dark)).not.toBe(bgOf(light));
  });

  it('emits landuse fills with subtle dark tints', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const ids = style.layers.map((layer) => layer.id);
    expect(ids).toContain('landuse_park');
    expect(ids).toContain('landuse_wood');
    expect(ids).toContain('landuse_residential');
    expect(ids).toContain('landuse_commercial');
    expect(ids).toContain('landuse_industrial');

    const bg = style.layers.find((layer) => layer.id === 'bg') as {
      paint: { 'background-color': string };
    };
    const park = style.layers.find((layer) => layer.id === 'landuse_park') as {
      paint: { 'fill-color': string };
    };
    const commercial = style.layers.find((layer) => layer.id === 'landuse_commercial') as {
      paint: { 'fill-color': string };
    };
    expect(
      Math.abs(
        luminance(park.paint['fill-color']) - luminance(bg.paint['background-color']),
      ),
    ).toBeLessThan(18);
    expect(
      Math.abs(
        luminance(commercial.paint['fill-color']) - luminance(bg.paint['background-color']),
      ),
    ).toBeLessThan(22);
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

  it('anchors world place labels as polygon-backed point symbols', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const country = style.layers.find((l) => l.id === 'world_place_country') as {
      layout: Record<string, unknown>;
    };
    const state = style.layers.find((l) => l.id === 'world_place_state') as {
      layout: Record<string, unknown>;
    };
    expect(country.layout['symbol-placement']).toBe('point');
    expect(state.layout['symbol-placement']).toBe('point');
  });

  it('renders world_admin1_boundary as a line layer over the world_labels source', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const layer = style.layers.find((l) => l.id === 'world_admin1_boundary') as
      | {
          type: string;
          source: string;
          filter: unknown;
          minzoom?: number;
          maxzoom?: number;
        }
      | undefined;
    expect(layer).toBeDefined();
    expect(layer?.type).toBe('line');
    // GeoJSON-backed source — Natural Earth admin-1 polygons live in
    // world-labels.geojson today; rendering polygons through a line
    // layer paints their outlines as boundary edges globally.
    expect(layer?.source).toBe('world_labels');
    expect(JSON.stringify(layer?.filter)).toContain('state');
    // Hands off to the per-region streets pmtiles (which carries OSM
    // admin_level=4 boundaries) above z8 so the two never stack.
    expect(layer?.maxzoom).toBe(8);
    expect(layer?.minzoom).toBeLessThanOrEqual(5);
  });

  it('renders world_admin1_label as a symbol layer with admin-1 names', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const layer = style.layers.find((l) => l.id === 'world_admin1_label') as
      | {
          type: string;
          source: string;
          filter: unknown;
          layout: Record<string, unknown>;
        }
      | undefined;
    expect(layer).toBeDefined();
    expect(layer?.type).toBe('symbol');
    expect(layer?.source).toBe('world_labels');
    expect(JSON.stringify(layer?.filter)).toContain('state');
    expect(layer?.layout['text-field']).toBeDefined();
    expect(JSON.stringify(layer?.layout['text-font'])).toContain('Noto Sans Regular');
    expect(layer?.layout['text-transform']).toBe('uppercase');
  });

  it('admin-1 boundary + label paint above country boundary, below street boundary', () => {
    const style = buildDarkStyle(TILE_URL, OVERVIEW_URL, LABELS_URL);
    const ids = style.layers.map((l) => l.id);
    const country = ids.indexOf('world_boundary_country');
    const admin1Boundary = ids.indexOf('world_admin1_boundary');
    const admin1Label = ids.indexOf('world_admin1_label');
    const street = ids.indexOf('boundary_state');
    expect(country).toBeGreaterThan(-1);
    expect(admin1Boundary).toBeGreaterThan(-1);
    expect(admin1Label).toBeGreaterThan(-1);
    expect(street).toBeGreaterThan(-1);
    expect(country).toBeLessThan(admin1Boundary);
    expect(admin1Boundary).toBeLessThan(admin1Label);
    expect(admin1Label).toBeLessThan(street);
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
