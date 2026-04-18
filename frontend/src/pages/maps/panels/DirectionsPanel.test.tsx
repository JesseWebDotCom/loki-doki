import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import DirectionsPanel from './DirectionsPanel';
import type { PlaceResult } from '../types';

vi.mock('@/utils/VoiceStreamer', () => ({
  VoiceStreamer: class {
    async stream() { /* no-op in tests */ }
    stop() { /* no-op */ }
  },
}));

const origin: PlaceResult = {
  place_id: 'origin-1',
  title: '500 Nyala Farms Rd',
  subtitle: 'Westport, CT',
  address_lines: ['500 Nyala Farms Rd', 'Westport, CT'],
  lat: 41.12,
  lon: -73.36,
};
const destination: PlaceResult = {
  place_id: 'dest-1',
  title: '150 Stiles St',
  subtitle: 'Milford, CT',
  address_lines: ['150 Stiles St', 'Milford, CT'],
  lat: 41.22,
  lon: -73.06,
};

type FetchFn = typeof globalThis.fetch;

interface RouteCall {
  url: string;
  body: Record<string, unknown>;
}

function installRouteMock(
  opts: { alternates?: number; emptyRoutes?: boolean } = {},
): { calls: RouteCall[] } {
  const calls: RouteCall[] = [];
  const alternates = opts.alternates ?? 2;
  const envelope = opts.emptyRoutes
    ? { routes: [], instructions_text: [], alternates: [], mechanism_used: 'valhalla' }
    : {
        routes: [
          {
            duration_s: 1560,
            distance_m: 18000,
            geometry: '_p~iF~ps|U_ulLnnqC',
            profile: 'auto',
            legs: [{ steps: [] }],
          },
        ],
        instructions_text: ['Head north', 'Arrive at destination'],
        alternates: Array.from({ length: alternates }, (_, i) => ({
          duration_s: 1560 + (i + 1) * 60,
          distance_m: 19000 + i * 500,
          geometry: '_p~iF~ps|U_ulLnnqC',
        })),
        mechanism_used: 'valhalla',
      };

  const fn: FetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/maps/route') && init?.method === 'POST') {
      calls.push({
        url,
        body: JSON.parse(String(init.body ?? '{}')),
      });
      return new Response(JSON.stringify(envelope), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as FetchFn;

  vi.stubGlobal('fetch', fn);
  return { calls };
}

describe('DirectionsPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Geolocation off — jsdom has no real provider and the panel already
    // handles this branch by leaving the row blank.
    Object.defineProperty(window.navigator, 'geolocation', {
      value: undefined,
      configurable: true,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it('renders with `to` pre-filled and a blank `from`', () => {
    installRouteMock();
    render(
      <DirectionsPanel
        toPlace={destination}
        fromPlace={null}
        viewportCenter={null}
        onClose={() => {}}
        onRoutesChanged={() => {}}
        onFitToCoords={() => {}}
      />,
    );
    const fromInput = screen.getByLabelText('From') as HTMLInputElement;
    const toInput = screen.getByLabelText('To') as HTMLInputElement;
    expect(fromInput.value).toBe('');
    expect(toInput.value).toBe('150 Stiles St');
  });

  it('fires the route fetch with both from and to resolved, using the chosen mode', async () => {
    const { calls } = installRouteMock();
    const onRoutesChanged = vi.fn();
    render(
      <DirectionsPanel
        toPlace={destination}
        fromPlace={origin}
        viewportCenter={null}
        onClose={() => {}}
        onRoutesChanged={onRoutesChanged}
        onFitToCoords={() => {}}
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    await waitFor(() => {
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
    expect(calls[0].body).toMatchObject({
      origin: { lat: origin.lat, lon: origin.lon },
      destination: { lat: destination.lat, lon: destination.lon },
      profile: 'auto',
      alternates: 3,
    });

    // Mode toggle → pedestrian changes the profile on next fetch.
    fireEvent.click(screen.getByRole('radio', { name: 'Walk' }));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => {
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
    expect(calls[calls.length - 1].body).toMatchObject({ profile: 'pedestrian' });
  });

  it('swaps From and To when the top row grip is clicked', async () => {
    installRouteMock();
    render(
      <DirectionsPanel
        toPlace={destination}
        fromPlace={origin}
        viewportCenter={null}
        onClose={() => {}}
        onRoutesChanged={() => {}}
        onFitToCoords={() => {}}
      />,
    );
    const row0 = screen.getByTestId('wp-row-0');
    const grip = within(row0).getByRole('button', { name: /Reorder row 1/i });
    fireEvent.click(grip);
    const fromInput = screen.getByLabelText('From') as HTMLInputElement;
    const toInput = screen.getByLabelText('To') as HTMLInputElement;
    expect(fromInput.value).toBe(destination.title);
    expect(toInput.value).toBe(origin.title);
  });

  it('surfaces an error state when the route fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('boom', { status: 500 }),
      ) as unknown as FetchFn,
    );
    render(
      <DirectionsPanel
        toPlace={destination}
        fromPlace={origin}
        viewportCenter={null}
        onClose={() => {}}
        onRoutesChanged={() => {}}
        onFitToCoords={() => {}}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
  });
});
