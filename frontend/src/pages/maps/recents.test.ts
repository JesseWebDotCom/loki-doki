import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearRecents, loadRecents, pushRecent, removeRecent } from './recents';
import type { PlaceResult } from './types';

const place = (id: string, title: string): PlaceResult => ({
  place_id: id,
  title,
  subtitle: 'Hartford, CT',
  address_lines: [title, 'Hartford, CT', 'United States'],
  lat: 41.76,
  lon: -72.67,
  kind: 'address',
});

// jsdom's built-in localStorage in vitest 4 lacks `clear()`; the repo's
// other tests stub the Storage API with a Map, so we do the same.
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
});

describe('recents', () => {
  afterEach(() => {
    clearRecents();
  });

  it('loadRecents returns [] with nothing stored', () => {
    expect(loadRecents()).toEqual([]);
  });

  it('pushRecent writes newest-first', () => {
    pushRecent(place('a', 'A'));
    pushRecent(place('b', 'B'));
    const list = loadRecents();
    expect(list.map((r) => r.place_id)).toEqual(['b', 'a']);
  });

  it('pushRecent dedupes by place_id and promotes to newest', () => {
    pushRecent(place('a', 'A'));
    pushRecent(place('b', 'B'));
    pushRecent(place('a', 'A (revisited)'));
    const list = loadRecents();
    expect(list.map((r) => r.place_id)).toEqual(['a', 'b']);
    expect(list[0].title).toBe('A (revisited)');
  });

  it('pushRecent caps the list at 10', () => {
    for (let i = 0; i < 15; i++) {
      pushRecent(place(`id-${i}`, `Place ${i}`));
    }
    const list = loadRecents();
    expect(list).toHaveLength(10);
    expect(list[0].place_id).toBe('id-14');
    expect(list[9].place_id).toBe('id-5');
  });

  it('loadRecents survives a corrupt localStorage payload', () => {
    window.localStorage.setItem('lokidoki.maps.recents.v1', '{not json');
    expect(loadRecents()).toEqual([]);
  });

  it('loadRecents drops entries missing required fields', () => {
    window.localStorage.setItem(
      'lokidoki.maps.recents.v1',
      JSON.stringify([
        { place_id: 'ok', title: 'ok', lat: 1, lon: 2, subtitle: '', address_lines: [], selected_at: 1 },
        { place_id: 'broken' }, // missing coords
      ]),
    );
    const list = loadRecents();
    expect(list.map((r) => r.place_id)).toEqual(['ok']);
  });

  it('removes a single recent by id, leaves others intact', () => {
    pushRecent(place('a', 'A'));
    pushRecent(place('b', 'B'));
    pushRecent(place('c', 'C'));

    const list = removeRecent('b');

    expect(list.map((r) => r.place_id)).toEqual(['c', 'a']);
    expect(loadRecents().map((r) => r.place_id)).toEqual(['c', 'a']);
  });
});
