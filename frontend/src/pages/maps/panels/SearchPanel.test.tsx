import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import SearchPanel from './SearchPanel';
import type { PlaceResult } from '../types';

const nominatimHit = {
  place_id: 101,
  display_name: '10 Main St, Hartford, CT, United States',
  lat: '41.76',
  lon: '-72.67',
  type: 'house',
  class: 'building',
  address: {
    house_number: '10',
    road: 'Main St',
    city: 'Hartford',
    state: 'CT',
    country: 'United States',
    postcode: '06103',
  },
};

const nominatimHit2 = {
  ...nominatimHit,
  place_id: 102,
  display_name: '22 Elm St, Hartford, CT, United States',
  address: { ...nominatimHit.address, house_number: '22', road: 'Elm St' },
};

function mockFetchWith(results: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(results), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );
}

describe('SearchPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it('renders the search input and empty-state helper', () => {
    render(
      <SearchPanel viewportCenter={null} onSelect={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole('tabpanel', { name: /Search places/i })).toBeTruthy();
    expect(
      screen.getByPlaceholderText(/Search Maps/i),
    ).toBeTruthy();
    expect(screen.getByText(/Try an address, city/i)).toBeTruthy();
  });

  it('debounces before hitting the geocoder', async () => {
    mockFetchWith([nominatimHit]);
    render(
      <SearchPanel viewportCenter={null} onSelect={() => {}} onClose={() => {}} />,
    );
    const input = screen.getByPlaceholderText(/Search Maps/i);
    fireEvent.change(input, { target: { value: 'Hart' } });
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  it('selects the highlighted row on Enter', async () => {
    mockFetchWith([nominatimHit, nominatimHit2]);
    const onSelect = vi.fn<(p: PlaceResult) => void>();
    render(
      <SearchPanel viewportCenter={null} onSelect={onSelect} onClose={() => {}} />,
    );
    const input = screen.getByPlaceholderText(/Search Maps/i);
    fireEvent.change(input, { target: { value: 'Main' } });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_PLUS);
    });
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBe(2);
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].place_id).toBe('101');
    expect(onSelect.mock.calls[0][0].title).toBe('10 Main St');
  });

  it('calls onSelect with a normalized PlaceResult on click', async () => {
    mockFetchWith([nominatimHit]);
    const onSelect = vi.fn<(p: PlaceResult) => void>();
    render(
      <SearchPanel viewportCenter={null} onSelect={onSelect} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Search Maps/i), {
      target: { value: '10 Main' },
    });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_PLUS);
    });
    const option = await screen.findByRole('option');
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledTimes(1);
    const got = onSelect.mock.calls[0][0];
    expect(got).toMatchObject({
      place_id: '101',
      title: '10 Main St',
      lat: 41.76,
      lon: -72.67,
    });
    expect(got.address_lines[0]).toBe('10 Main St');
  });

  it('arrow keys move the selection cursor', async () => {
    mockFetchWith([nominatimHit, nominatimHit2]);
    render(
      <SearchPanel viewportCenter={null} onSelect={() => {}} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Search Maps/i), {
      target: { value: 'Main' },
    });
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_PLUS);
    });
    await waitFor(() => {
      expect(screen.getAllByRole('option').length).toBe(2);
    });
    const input = screen.getByPlaceholderText(/Search Maps/i);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const opts = screen.getAllByRole('option');
    expect(opts[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    const opts2 = screen.getAllByRole('option');
    expect(opts2[0].getAttribute('aria-selected')).toBe('true');
  });
});

const DEBOUNCE_PLUS = 400;
