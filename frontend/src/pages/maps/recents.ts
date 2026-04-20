/**
 * Recent places persistence (localStorage-backed, cap 10, newest first).
 *
 * Deliberately tiny — every Chunk 4 panel imports this directly instead
 * of threading a context provider; the reference UI treats Recents as
 * an ambient sidebar list, not page-level state.
 */
import type { PlaceResult, Recent } from './types';

const STORAGE_KEY = 'lokidoki.maps.recents.v1';
const DIRECTIONS_STORAGE_KEY = 'lokidoki.maps.directions-recents.v1';
const CAP = 10;

export type DirectionsMode = 'auto' | 'pedestrian' | 'bicycle';

export interface DirectionsRecent {
  id: string;
  from: PlaceResult;
  to: PlaceResult;
  mode: DirectionsMode;
  selected_at: number;
}

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

export function removeRecent(placeId: string): Recent[] {
  const store = safeStorage();
  const next = loadRecents().filter((r) => r.place_id !== placeId);
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

// ── Directions recents ─────────────────────────────────────────────

function isDirectionsRecent(v: unknown): v is DirectionsRecent {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<DirectionsRecent>;
  return (
    typeof r.id === 'string' &&
    !!r.from && typeof r.from.lat === 'number' && typeof r.from.lon === 'number' &&
    !!r.to && typeof r.to.lat === 'number' && typeof r.to.lon === 'number' &&
    (r.mode === 'auto' || r.mode === 'pedestrian' || r.mode === 'bicycle')
  );
}

export function loadDirectionsRecents(): DirectionsRecent[] {
  const store = safeStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(DIRECTIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDirectionsRecent).slice(0, CAP);
  } catch {
    return [];
  }
}

export function pushDirectionsRecent(args: {
  from: PlaceResult;
  to: PlaceResult;
  mode: DirectionsMode;
}): DirectionsRecent[] {
  const store = safeStorage();
  const id = `${args.from.place_id}->${args.to.place_id}:${args.mode}`;
  const entry: DirectionsRecent = {
    id,
    from: args.from,
    to: args.to,
    mode: args.mode,
    selected_at: Date.now(),
  };
  const existing = loadDirectionsRecents().filter((r) => r.id !== id);
  const next = [entry, ...existing].slice(0, CAP);
  if (store) {
    try {
      store.setItem(DIRECTIONS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Quota / private-mode — degrade to in-memory only.
    }
  }
  return next;
}
