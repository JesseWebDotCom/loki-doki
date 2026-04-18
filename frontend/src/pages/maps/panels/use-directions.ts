/**
 * `useDirections` — form state + debounced POST /api/v1/maps/route.
 *
 * Owns the mode, waypoint rows, avoid flags, and selected-alternate
 * index. Whenever origin + destination are both resolved, fires a
 * debounced fetch; the returned `alternates` array is always sorted with
 * the primary (fastest) first and `is_fastest` flagged on the shortest.
 * Errors surface as a string — the panel decides whether to render them
 * inline or as an overlay.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AvoidState,
  DirectionsRequestBody,
  DirectionsResponseEnvelope,
  Maneuver,
  ModeId,
  RouteAlt,
  WaypointRow,
} from './DirectionsPanel.types';
import { decodePolyline6 } from '../route-layer';
import type { PlaceResult } from '../types';

const ROUTE_URL = '/api/v1/maps/route';
const DEBOUNCE_MS = 250;
const ALTERNATES = 3;

export interface UseDirectionsInit {
  to?: PlaceResult | null;
  from?: PlaceResult | null;
  mode?: ModeId;
}

export interface UseDirectionsResult {
  mode: ModeId;
  setMode: (m: ModeId) => void;
  rows: WaypointRow[];
  setRowText: (rid: string, text: string) => void;
  resolveRow: (rid: string, place: PlaceResult) => void;
  swapRows: (aIdx: number, bIdx: number) => void;
  addWaypoint: () => void;
  removeRow: (rid: string) => void;
  avoid: AvoidState;
  setAvoid: (next: AvoidState) => void;
  alternates: RouteAlt[];
  selectedIdx: number;
  select: (idx: number) => void;
  isLoading: boolean;
  error: string | null;
  offline: boolean;
}

const EMPTY_AVOID: AvoidState = { highways: false, tolls: false, ferries: false };
const MAX_WAYPOINTS = 5;

function makeRow(text: string, place: PlaceResult | null, isOrigin = false): WaypointRow {
  return {
    rid: `wp_${Math.random().toString(36).slice(2, 10)}`,
    text,
    place,
    isOrigin,
  };
}

function rowsFromInit(init?: UseDirectionsInit): WaypointRow[] {
  const from: WaypointRow = init?.from
    ? makeRow(init.from.title, init.from, true)
    : makeRow('', null, true);
  const to: WaypointRow = init?.to
    ? makeRow(init.to.title, init.to, false)
    : makeRow('', null, false);
  return [from, to];
}

export function useDirections(init?: UseDirectionsInit): UseDirectionsResult {
  const [mode, setModeState] = useState<ModeId>(init?.mode ?? 'auto');
  const [rows, setRows] = useState<WaypointRow[]>(() => rowsFromInit(init));
  const [avoid, setAvoidState] = useState<AvoidState>(EMPTY_AVOID);
  const [alternates, setAlternates] = useState<RouteAlt[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const setRowText = useCallback((rid: string, text: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.rid === rid
          ? // Clearing / editing text un-resolves the place — the user is
            // re-typing, so the old coordinates no longer describe the row.
            { ...r, text, place: r.place && r.place.title === text ? r.place : null }
          : r,
      ),
    );
  }, []);

  const resolveRow = useCallback((rid: string, place: PlaceResult) => {
    setRows((prev) =>
      prev.map((r) => (r.rid === rid ? { ...r, text: place.title, place } : r)),
    );
  }, []);

  const swapRows = useCallback((aIdx: number, bIdx: number) => {
    setRows((prev) => {
      if (aIdx < 0 || bIdx < 0 || aIdx >= prev.length || bIdx >= prev.length) {
        return prev;
      }
      const next = [...prev];
      [next[aIdx], next[bIdx]] = [next[bIdx], next[aIdx]];
      // Origin flag follows position — first row is always origin.
      return next.map((r, i) => ({ ...r, isOrigin: i === 0 }));
    });
  }, []);

  const addWaypoint = useCallback(() => {
    setRows((prev) => {
      if (prev.length >= MAX_WAYPOINTS) return prev;
      // Insert before the last (destination) row.
      const before = prev.slice(0, prev.length - 1);
      const last = prev[prev.length - 1];
      return [...before, makeRow('', null, false), last];
    });
  }, []);

  const removeRow = useCallback((rid: string) => {
    setRows((prev) => (prev.length <= 2 ? prev : prev.filter((r) => r.rid !== rid)));
  }, []);

  const setMode = useCallback((m: ModeId) => setModeState(m), []);
  const setAvoid = useCallback((next: AvoidState) => setAvoidState(next), []);
  const select = useCallback((idx: number) => setSelectedIdx(idx), []);

  const body = useMemo<DirectionsRequestBody | null>(() => {
    const resolved = rows.filter((r) => r.place != null);
    if (resolved.length < 2) return null;
    const places = resolved.map((r) => r.place!);
    const origin = places[0];
    const destination = places[places.length - 1];
    const mids = places.slice(1, -1);
    return {
      origin: { lat: origin.lat, lon: origin.lon },
      destination: { lat: destination.lat, lon: destination.lon },
      waypoints: mids.map((p) => ({ lat: p.lat, lon: p.lon })),
      profile: mode,
      alternates: ALTERNATES,
      avoid,
    };
  }, [rows, mode, avoid]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!body) {
      setAlternates([]);
      setError(null);
      setOffline(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      setOffline(false);
      fetch(ROUTE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`Route ${res.status}`);
          const env = (await res.json()) as DirectionsResponseEnvelope;
          if (env.offline) {
            setAlternates([]);
            setOffline(true);
            return;
          }
          setAlternates(normaliseAlternates(env));
          setSelectedIdx(0);
        })
        .catch((e: unknown) => {
          if ((e as { name?: string }).name === 'AbortError') return;
          setAlternates([]);
          setError(e instanceof Error ? e.message : 'Route failed');
        })
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [body]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    mode,
    setMode,
    rows,
    setRowText,
    resolveRow,
    swapRows,
    addWaypoint,
    removeRow,
    avoid,
    setAvoid,
    alternates,
    selectedIdx,
    select,
    isLoading,
    error,
    offline,
  };
}

function normaliseAlternates(env: DirectionsResponseEnvelope): RouteAlt[] {
  const primary = env.routes[0];
  if (!primary) return [];
  const steps: Maneuver[] = primary.legs.flatMap((l) => l.steps) ?? [];

  const primaryAlt: RouteAlt = {
    duration_s: primary.duration_s,
    distance_m: primary.distance_m,
    geometry: primary.geometry,
    coords: decodePolyline6(primary.geometry),
    maneuvers: steps,
    instructions_text: env.instructions_text ?? [],
    is_fastest: false,
  };

  const others: RouteAlt[] = (env.alternates ?? []).map((a) => ({
    duration_s: a.duration_s,
    distance_m: a.distance_m,
    geometry: a.geometry,
    coords: decodePolyline6(a.geometry),
    maneuvers: [],
    instructions_text: [],
    is_fastest: false,
  }));

  const all = [primaryAlt, ...others];
  if (all.length === 0) return all;
  let fastestIdx = 0;
  for (let i = 1; i < all.length; i++) {
    if (all[i].duration_s < all[fastestIdx].duration_s) fastestIdx = i;
  }
  all[fastestIdx].is_fastest = true;
  return all;
}
