/**
 * `useDirections` — form state + debounced POST /api/maps/route.
 *
 * Owns the mode, origin/destination/waypoint rows, avoid flags, and
 * selected-alternate index. Whenever origin + destination are both
 * resolved, fires a debounced fetch; the returned `alternates` array is
 * always sorted with the primary (fastest) first and `is_fastest`
 * flagged on the shortest. Errors surface as a string and unavailable
 * routers as a separate `unavailable` flag.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  requestRoute,
  RouteUnavailableError,
  type RouteResponseWire,
  type RouterMode,
} from "./api";
import { decodeGeometry } from "./route-layer";
import type { PlaceResult } from "./types";

const DEBOUNCE_MS = 250;
const ALTERNATES: 0 | 1 | 2 = 2;
const MAX_WAYPOINTS = 5;

export type DirectionsMode = RouterMode;

export interface AvoidState {
  highways: boolean;
  tolls: boolean;
  ferries: boolean;
}

export interface RouteAlt {
  duration_s: number;
  distance_m: number;
  geometry: string;
  coords: [number, number][];
  maneuvers: ManeuverView[];
  instructions_text: string[];
  is_fastest: boolean;
  mechanism_used: "graphhopper" | "osrm";
}

export interface ManeuverView {
  text: string;
  distance_m: number;
  duration_s: number;
  sign: number;
  interval: [number, number];
  street_name: string | null;
}

export interface WaypointRow {
  rid: string;
  place: PlaceResult | null;
  isOrigin: boolean;
}

export interface UseDirectionsInit {
  from?: PlaceResult | null;
  to?: PlaceResult | null;
  mode?: DirectionsMode;
  initialAvoid?: AvoidState;
  initialDifficultyCap?: number | null;
}

export interface UseDirectionsResult {
  mode: DirectionsMode;
  setMode: (m: DirectionsMode) => void;
  rows: WaypointRow[];
  setRowPlace: (rid: string, place: PlaceResult | null) => void;
  swapEndpoints: () => void;
  addWaypoint: () => void;
  removeRow: (rid: string) => void;
  avoid: AvoidState;
  setAvoid: (next: AvoidState) => void;
  difficultyCap: number | null;
  setDifficultyCap: (cap: number | null) => void;
  alternates: RouteAlt[];
  selectedIdx: number;
  setSelectedIdx: (idx: number) => void;
  isLoading: boolean;
  error: string | null;
  unavailable: boolean;
}

const EMPTY_AVOID: AvoidState = { highways: false, tolls: false, ferries: false };

function makeRow(place: PlaceResult | null, isOrigin: boolean): WaypointRow {
  return {
    rid: `wp_${Math.random().toString(36).slice(2, 10)}`,
    place,
    isOrigin,
  };
}

function rowsFromInit(init?: UseDirectionsInit): WaypointRow[] {
  return [makeRow(init?.from ?? null, true), makeRow(init?.to ?? null, false)];
}

export function useDirections(init?: UseDirectionsInit): UseDirectionsResult {
  const [mode, setMode] = useState<DirectionsMode>(init?.mode ?? "auto");
  const [rows, setRows] = useState<WaypointRow[]>(() => rowsFromInit(init));
  const [avoid, setAvoid] = useState<AvoidState>(init?.initialAvoid ?? EMPTY_AVOID);
  const [difficultyCap, setDifficultyCap] = useState<number | null>(init?.initialDifficultyCap ?? null);
  const [alternates, setAlternates] = useState<RouteAlt[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setRowPlace = useCallback((rid: string, place: PlaceResult | null) => {
    setRows((prev) => prev.map((r) => (r.rid === rid ? { ...r, place } : r)));
  }, []);

  const swapEndpoints = useCallback(() => {
    setRows((prev) => {
      if (prev.length < 2) return prev;
      const next = [...prev];
      const last = next.length - 1;
      [next[0], next[last]] = [next[last], next[0]];
      return next.map((r, i) => ({ ...r, isOrigin: i === 0 }));
    });
  }, []);

  const addWaypoint = useCallback(() => {
    setRows((prev) => {
      if (prev.length >= MAX_WAYPOINTS) return prev;
      const before = prev.slice(0, prev.length - 1);
      const last = prev[prev.length - 1];
      return [...before, makeRow(null, false), last];
    });
  }, []);

  const removeRow = useCallback((rid: string) => {
    setRows((prev) => (prev.length <= 2 ? prev : prev.filter((r) => r.rid !== rid)));
  }, []);

  const body = useMemo(() => {
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
      ...(difficultyCap != null && (mode === "hiking" || mode === "mtb") ? { difficulty_cap: difficultyCap } : {}),
    };
  }, [rows, mode, avoid, difficultyCap]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!body) {
      setAlternates([]);
      setError(null);
      setUnavailable(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      setUnavailable(false);
      requestRoute(body, controller.signal)
        .then((wire) => {
          setAlternates(normaliseAlternates(wire));
          setSelectedIdx(0);
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name === "AbortError") return;
          setAlternates([]);
          if (err instanceof RouteUnavailableError) {
            setUnavailable(true);
            setError(err.message);
            return;
          }
          setError(err instanceof Error ? err.message : "Route failed");
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
    setRowPlace,
    swapEndpoints,
    addWaypoint,
    removeRow,
    avoid,
    setAvoid,
    difficultyCap,
    setDifficultyCap,
    alternates,
    selectedIdx,
    setSelectedIdx,
    isLoading,
    error,
    unavailable,
  };
}

function normaliseAlternates(env: RouteResponseWire): RouteAlt[] {
  const primary = env.routes[0];
  if (!primary) return [];
  const primarySteps: ManeuverView[] = primary.legs.flatMap((l) => l.steps);
  const primaryAlt: RouteAlt = {
    duration_s: primary.duration_s,
    distance_m: primary.distance_m,
    geometry: primary.geometry,
    coords: decodeGeometry(primary.geometry),
    maneuvers: primarySteps,
    instructions_text: env.instructions_text ?? [],
    is_fastest: false,
    mechanism_used: env.mechanism_used,
  };
  const others: RouteAlt[] = (env.alternates ?? []).map((a) => ({
    duration_s: a.duration_s,
    distance_m: a.distance_m,
    geometry: a.geometry,
    coords: decodeGeometry(a.geometry),
    maneuvers: a.legs.flatMap((l) => l.steps),
    instructions_text: [],
    is_fastest: false,
    mechanism_used: env.mechanism_used,
  }));
  const all = [primaryAlt, ...others];
  if (all.length === 0) return all;
  let fastestIdx = 0;
  for (let i = 1; i < all.length; i += 1) {
    if (all[i].duration_s < all[fastestIdx].duration_s) fastestIdx = i;
  }
  all[fastestIdx].is_fastest = true;
  return all;
}
