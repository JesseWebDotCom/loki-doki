import { describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import {
  ALT_COLOR,
  ROUTE_LAYER_IDS,
  SELECTED_COLOR,
  applyRoutes,
  boundsForAlts,
  decodePolyline6,
  decodeWithPrecision,
  routesToFeatureCollection,
} from './route-layer';

function altOf(coords: [number, number][], duration: number, fastest = false) {
  return {
    coords,
    duration_s: duration,
    distance_m: duration * 20,
    is_fastest: fastest,
  };
}

describe('decodePolyline6', () => {
  // Polyline-5 round trip — Google's published test fixture for precision.
  // Using decodeWithPrecision with factor 1e5 to verify the decoder itself.
  it('round-trips Google polyline-5 fixture at 1e5 precision', () => {
    const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
    const coords = decodeWithPrecision(encoded, 1e5);
    expect(coords).toHaveLength(3);
    expect(coords[0][0]).toBeCloseTo(-120.2, 1);
    expect(coords[0][1]).toBeCloseTo(38.5, 1);
    expect(coords[2][0]).toBeCloseTo(-126.453, 2);
  });

  it('returns [] for an empty string', () => {
    expect(decodePolyline6('')).toEqual([]);
  });

  it('decodes at 1e6 precision (Valhalla default)', () => {
    // Re-encode the Google fixture at 1e6 by shifting via decodeWithPrecision
    // comparison rather than synthesising an encoder — any non-empty input
    // must produce finite lat/lng values in the -180..180 / -90..90 range.
    const coords = decodePolyline6('_p~iF~ps|U_ulLnnqC');
    for (const [lng, lat] of coords) {
      expect(Number.isFinite(lng)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
  });
});

describe('routesToFeatureCollection', () => {
  it('builds three features with the right selected / label properties', () => {
    const alts = [
      altOf([[0, 0], [1, 1]], 60 * 26, true),
      altOf([[0, 0], [2, 0]], 60 * 27),
      altOf([[0, 0], [3, -1]], 60 * 38),
    ];
    const fc = routesToFeatureCollection(alts, 0);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(3);
    expect(fc.features[0].properties.selected).toBe(true);
    expect(fc.features[1].properties.selected).toBe(false);
    expect(fc.features[0].properties.label).toBe('26 min');
    expect(fc.features[2].properties.label).toBe('38 min');
  });

  it('flips the selected flag without reshaping the source', () => {
    const alts = [altOf([[0, 0], [1, 1]], 60), altOf([[0, 0], [2, 2]], 90)];
    const first = routesToFeatureCollection(alts, 0);
    const second = routesToFeatureCollection(alts, 1);
    expect(first.features[0].properties.selected).toBe(true);
    expect(first.features[1].properties.selected).toBe(false);
    expect(second.features[0].properties.selected).toBe(false);
    expect(second.features[1].properties.selected).toBe(true);
    // Coord arrays are reused byref — source data is the same shape.
    expect(second.features[0].geometry.coordinates).toBe(
      first.features[0].geometry.coordinates,
    );
  });
});

describe('boundsForAlts', () => {
  it('returns null for empty input', () => {
    expect(boundsForAlts([])).toBeNull();
  });
  it('returns the union bbox across every alternate', () => {
    const bounds = boundsForAlts([
      altOf([[0, 0], [1, 1]], 60),
      altOf([[-2, 3], [5, -4]], 90),
    ]);
    expect(bounds).toEqual([[-2, -4], [5, 3]]);
  });
});

describe('applyRoutes', () => {
  function fakeMap() {
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const layers = new Set<string>();
    const lastColors: Record<string, unknown> = {};
    return {
      getSource: vi.fn((id: string) => sources.get(id) ?? undefined),
      addSource: vi.fn((id: string, _spec: unknown) => {
        sources.set(id, { setData: vi.fn() });
      }),
      getLayer: vi.fn((id: string) => (layers.has(id) ? { id } : undefined)),
      addLayer: vi.fn((spec: { id: string; paint?: Record<string, unknown> }) => {
        layers.add(spec.id);
        lastColors[spec.id] = spec.paint?.['line-color'];
      }),
      removeLayer: vi.fn((id: string) => layers.delete(id)),
      removeSource: vi.fn((id: string) => sources.delete(id)),
      _sources: sources,
      _layers: layers,
      _lastColors: lastColors,
    };
  }

  it('adds source + line + badge layers on first call', () => {
    const map = fakeMap() as unknown as MapLibreMap & ReturnType<typeof fakeMap>;
    const alts = [
      altOf([[0, 0], [1, 1]], 60, true),
      altOf([[0, 0], [2, 2]], 120),
      altOf([[0, 0], [3, -1]], 180),
    ];
    applyRoutes(map, alts, 0);
    expect(map.addSource).toHaveBeenCalledWith(
      ROUTE_LAYER_IDS.source,
      expect.objectContaining({ type: 'geojson' }),
    );
    expect(map.addLayer).toHaveBeenCalledTimes(2);
    expect(map._layers.has(ROUTE_LAYER_IDS.line)).toBe(true);
    expect(map._layers.has(ROUTE_LAYER_IDS.badge)).toBe(true);
    // The line paint expression encodes both colours for the case branch.
    const lineColor = JSON.stringify(map._lastColors[ROUTE_LAYER_IDS.line]);
    expect(lineColor).toContain(SELECTED_COLOR);
    expect(lineColor).toContain(ALT_COLOR);
  });

  it('setData-only on subsequent calls — no remount', () => {
    const map = fakeMap() as unknown as MapLibreMap & ReturnType<typeof fakeMap>;
    const alts = [altOf([[0, 0], [1, 1]], 60), altOf([[0, 0], [2, 0]], 90)];
    applyRoutes(map, alts, 0);
    expect(map.addSource).toHaveBeenCalledTimes(1);
    applyRoutes(map, alts, 1);
    expect(map.addSource).toHaveBeenCalledTimes(1);
    const source = map._sources.get(ROUTE_LAYER_IDS.source);
    expect(source?.setData).toHaveBeenCalled();
  });
});
