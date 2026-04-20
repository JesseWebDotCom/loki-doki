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
    setPopup() { return this; }
    addTo() { return this; }
    togglePopup() { return this; }
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
            city: 'Milford',
            state: 'CT',
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
    expect(canvasStyle.cursor).toBe('pointer');

    const leaveHandler = mapHandlers.get('mouseleave:poi_icon')?.[0];
    await leaveHandler?.();

    await waitFor(() => {
      expect(screen.queryByTestId('poi-hover-preview')).toBeNull();
    });
    expect(canvasStyle.cursor).toBe('');
  });
});
