/**
 * Recent places persistence (localStorage-backed, cap 10, newest first).
 *
 * Deliberately tiny — every Chunk 4 panel imports this directly instead
 * of threading a context provider; the reference UI treats Recents as
 * an ambient sidebar list, not page-level state.
 */
import type { PlaceResult, Recent } from './types';

const STORAGE_KEY = 'lokidoki.maps.recents.v1';
const CAP = 10;

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadRecents(): Recent[] {
  const store = safeStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as Recent[])
      .filter(
        (r): r is Recent =>
          !!r &&
          typeof r.place_id === 'string' &&
          typeof r.title === 'string' &&
          typeof r.lat === 'number' &&
          typeof r.lon === 'number',
      )
      .slice(0, CAP);
  } catch {
    return [];
  }
}

export function pushRecent(place: PlaceResult): Recent[] {
  const store = safeStorage();
  const entry: Recent = { ...place, selected_at: Date.now() };
  const existing = loadRecents().filter((r) => r.place_id !== place.place_id);
  const next = [entry, ...existing].slice(0, CAP);
  if (store) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota / private-mode — degrade to in-memory only for this session.
    }
  }
  return next;
}

export function clearRecents(): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
