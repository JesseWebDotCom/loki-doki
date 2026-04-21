import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MapsPage from './MapsPage';

// jsdom under vitest 4 ships a partial Storage; existing tests stub it
// with a Map-backed shim so the use-map-theme hook can read a mapTheme
// preference without crashing during MapsPage render.
const storage = new Map<string, string>();

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
      clear: () => { storage.clear(); },
      key: () => null,
      length: 0,
    },
  });
  storage.clear();
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  }));
});

const mapHandlers = new Map<string, ((event?: unknown) => void | Promise<void>)[]>();
const queryRenderedFeatures = vi.fn();
const markerSetPopup = vi.fn();
const markerTogglePopup = vi.fn();
const canvasStyle = { cursor: '' };
const mockMap = {
  addControl: vi.fn(),
  on: vi.fn((...args: unknown[]) => {
    const [event, second, third] = args;
    const eventName = event as string;
    const handler = (typeof second === 'function' ? second : third) as (
      event?: unknown,
    ) => void | Promise<void>;
    const layer = typeof second === 'string' ? second : null;
    const key = layer ? `${eventName}:${layer}` : eventName;
    const handlers = mapHandlers.get(key) ?? [];
    handlers.push(handler);
    mapHandlers.set(key, handlers);
    if (eventName === 'load') {
      handler();
    }
  }),
  off: vi.fn((...args: unknown[]) => {
    const [event, second, third] = args;
    const eventName = event as string;
    const handler = (typeof second === 'function' ? second : third) as (
      event?: unknown,
    ) => void | Promise<void>;
    const layer = typeof second === 'string' ? second : null;
    const key = layer ? `${eventName}:${layer}` : eventName;
    const handlers = mapHandlers.get(key) ?? [];
    mapHandlers.set(key, handlers.filter((item) => item !== handler));
  }),
  getCanvas: vi.fn(() => ({
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    style: canvasStyle,
  })),
  resize: vi.fn(),
  setStyle: vi.fn(),
  getCenter: vi.fn(() => ({ lng: -73.36, lat: 41.12 })),
  remove: vi.fn(),
  fitBounds: vi.fn(),
  getPitch: vi.fn(() => 0),
  easeTo: vi.fn(),
  flyTo: vi.fn(),
  triggerRepaint: vi.fn(),
  queryRenderedFeatures,
  getLayer: vi.fn((id: string) => ({ id })),
  project: vi.fn(() => ({ x: 0, y: 0 })),
};

vi.mock('pmtiles', () => ({
  Protocol: class {
    tile() {
      return {} as never;
    }
  },
}));

vi.mock('maplibre-gl', () => {
  class MapCtor {
    constructor() {
      return mockMap;
    }
  }

  class Marker {
    setLngLat() { return this; }
    setPopup(...args: unknown[]) { markerSetPopup(...args); return this; }
    addTo() { return this; }
    togglePopup() { markerTogglePopup(); return this; }
    remove() { return this; }
  }

  class Popup {
    setText() { return this; }
  }

  return {
    default: {
      Map: MapCtor,
      Marker,
      Popup,
      NavigationControl: class {},
      GeolocateControl: class {},
      addProtocol: vi.fn(),
    },
    Map: MapCtor,
    Marker,
    Popup,
  };
});

vi.mock('./maps/tile-source', () => ({
  fetchInstalledRegions: vi.fn(async () => []),
  resolveTileSource: vi.fn(async () => ({
    kind: 'local',
    region: 'us-ct',
    streetUrl: 'pmtiles:///maps/regions/us-ct/streets.pmtiles',
  })),
}));

vi.mock('./maps/LeftRail', () => ({
  default: () => <div data-testid="left-rail" />,
}));
vi.mock('./maps/panels/SearchPanel', () => ({
  default: () => <div data-testid="search-panel" />,
}));
vi.mock('./maps/panels/GuidesPanel', () => ({
  default: () => <div data-testid="guides-panel" />,
}));
vi.mock('./maps/panels/DirectionsPanel', () => ({
  default: () => <div data-testid="directions-panel" />,
}));
vi.mock('./maps/LayerModeChip', () => ({
  default: () => <div data-testid="layer-mode-chip" />,
}));
vi.mock('./maps/OutOfCoverageBanner', () => ({
  default: () => <div data-testid="coverage-banner" />,
}));

describe('MapsPage', () => {
  afterEach(() => {
    cleanup();
    mapHandlers.clear();
    canvasStyle.cursor = '';
    queryRenderedFeatures.mockReset();
    markerSetPopup.mockReset();
    markerTogglePopup.mockReset();
    vi.restoreAllMocks();
  });

  it('opens PlaceDetailsCard when a POI is clicked', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    queryRenderedFeatures.mockReturnValue([
      {
        id: 'poi-1',
        properties: {
          name: 'Bridgewater Associates',
          class: 'restaurant',
          city: 'Westport',
          state: 'CT',
        },
      },
    ]);

    render(
      <MemoryRouter>
        <MapsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mapHandlers.get('click')?.length).toBeGreaterThan(0);
    });

    const clickHandler = mapHandlers.get('click')?.[0];
    await clickHandler?.({
      point: { x: 10, y: 20 },
      lngLat: { lng: -73.3644, lat: 41.1187 },
    });

    await waitFor(() => {
      expect(screen.getByText('Bridgewater Associates')).toBeTruthy();
    });
    expect(screen.getByRole('tabpanel', { name: 'Place details' })).toBeTruthy();
    expect(markerSetPopup).not.toHaveBeenCalled();
    expect(markerTogglePopup).not.toHaveBeenCalled();
  });

  it('humanizes raw POI category text in the place card subtitle', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    queryRenderedFeatures.mockReturnValue([
      {
        id: 'poi-2',
        properties: {
          name: 'Burger Spot',
          class: 'fast_food',
        },
      },
    ]);

    render(
      <MemoryRouter>
        <MapsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mapHandlers.get('click')?.length).toBeGreaterThan(0);
    });

    const clickHandler = mapHandlers.get('click')?.[0];
    await clickHandler?.({
      point: { x: 10, y: 20 },
      lngLat: { lng: -73.3644, lat: 41.1187 },
    });

    await waitFor(() => {
      expect(screen.getByText('Fast Food')).toBeTruthy();
    });
  });

  it('shows a hover preview when cursor enters a POI icon', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      },
    );
    vi.stubGlobal('cancelAnimationFrame', () => {});

    render(
      <MemoryRouter>
        <MapsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mapHandlers.get('mousemove:poi_icon')?.length).toBeGreaterThan(0);
    });

    const moveHandler = mapHandlers.get('mousemove:poi_icon')?.[0];
    await moveHandler?.({
      features: [
        {
          properties: {
            name: 'Cafe Picolo',
            class: 'cafe',
            subclass: 'cafe',
            'addr:housenumber': '989',
            'addr:street': 'Boston Post Rd',
            'addr:city': 'Milford',
            'addr:state': 'CT',
            'addr:postcode': '06460',
          },
        },
      ],
      originalEvent: { clientX: 200, clientY: 120 },
      point: { x: 200, y: 120 },
    });

    await waitFor(() => {
      expect(screen.getByTestId('poi-hover-preview')).toBeTruthy();
    });
    expect(screen.getByText('Cafe Picolo')).toBeTruthy();
    expect(screen.getByText('Cafe')).toBeTruthy();
    expect(screen.getByText('989 Boston Post Rd')).toBeTruthy();
    expect(screen.getByText('Milford, CT 06460')).toBeTruthy();
    expect(canvasStyle.cursor).toBe('pointer');

    const leaveHandler = mapHandlers.get('mouseleave:poi_icon')?.[0];
    await leaveHandler?.();

    await waitFor(() => {
      expect(screen.queryByTestId('poi-hover-preview')).toBeNull();
    });
    expect(canvasStyle.cursor).toBe('');
  });

  it('backfills the hover preview with reverse-geocoded address lines when the POI lacks them', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      },
    );
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          place_id: 'rev-1',
          title: '194 Amity Rd',
          subtitle: 'Bethany, CT 06524',
          lat: 41.4216,
          lon: -72.9971,
          source: 'reverse',
        }),
      })),
    );

    render(
      <MemoryRouter>
        <MapsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mapHandlers.get('mousemove:poi_icon')?.length).toBeGreaterThan(0);
    });

    const moveHandler = mapHandlers.get('mousemove:poi_icon')?.[0];
    await moveHandler?.({
      features: [
        {
          properties: {
            name: 'Family Dental Care',
            class: 'clinic',
            subclass: 'dentist',
          },
        },
      ],
      originalEvent: { clientX: 220, clientY: 140 },
      point: { x: 220, y: 140 },
      lngLat: { lng: -72.9971, lat: 41.4216 },
    });

    await waitFor(() => {
      expect(screen.getByText('194 Amity Rd')).toBeTruthy();
    });
    expect(screen.getByText('Dentist')).toBeTruthy();
    expect(screen.getByText('Bethany, CT 06524')).toBeTruthy();
  });

  it('renders a subclass icon + label when hovering an unlabelled building that reverse-geocodes to a POI', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      },
    );
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          place_id: 'rev-3',
          title: 'Barosa Indian Kitchen',
          subtitle: '157 Cherry St, Milford, CT 06460',
          lat: 41.2429,
          lon: -73.069,
          source: 'reverse',
          category: 'poi:amenity:restaurant',
        }),
      })),
    );

    render(
      <MemoryRouter>
        <MapsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mapHandlers.get('mousemove:buildings-3d')?.length).toBeGreaterThan(0);
    });

    const moveHandler = mapHandlers.get('mousemove:buildings-3d')?.[0];
    await moveHandler?.({
      features: [{ properties: { render_height: 8 } }],
      originalEvent: { clientX: 300, clientY: 220 },
      point: { x: 300, y: 220 },
      lngLat: { lng: -73.069, lat: 41.2429 },
    });

    await waitFor(() => {
      expect(screen.getByText('Barosa Indian Kitchen')).toBeTruthy();
    });
    expect(screen.getByText('Restaurant')).toBeTruthy();
    const badge = screen.getByTestId('poi-hover-badge');
    const img = badge.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/sprites/source/restaurant.svg');
  });

  it('falls back to the category when reverse geocode only returns a duplicate POI name and region code', async () => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => {
        cb(0);
        return 1;
      },
    );
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          place_id: 'rev-2',
          title: 'Foodland',
          subtitle: 'us-ct',
          lat: 41.2317,
          lon: -73.0457,
          source: 'reverse',
        }),
      })),
    );

    render(
      <MemoryRouter>
        <MapsPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(mapHandlers.get('mousemove:poi_icon')?.length).toBeGreaterThan(0);
    });

    const moveHandler = mapHandlers.get('mousemove:poi_icon')?.[0];
    await moveHandler?.({
      features: [
        {
          properties: {
            name: 'Foodland',
            class: 'grocery',
          },
        },
      ],
      originalEvent: { clientX: 240, clientY: 160 },
      point: { x: 240, y: 160 },
      lngLat: { lng: -73.0457, lat: 41.2317 },
    });

    await waitFor(() => {
      expect(screen.getByText('Grocery')).toBeTruthy();
    });
    expect(screen.queryByText('us-ct')).toBeNull();
    expect(screen.getAllByText('Foodland')).toHaveLength(1);
  });
});
