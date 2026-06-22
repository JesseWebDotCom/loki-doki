/**
 * Hover-identity helpers for map click resolution.
 *
 * `resolveHoverIdentity` — unnamed features (building polygons): reverse-geocode
 * the click point and return the nearest FTS entry within HOVER_RADIUS_KM.
 *
 * `resolveByName` — named POI label features: forward-search by the tile name
 * and pick the closest result within NAME_SEARCH_MAX_KM. More reliable than
 * reverse-geocode when tile and FTS coordinates diverge on large-lot POIs.
 */
import { reverseGeocode, searchPlaces } from "./api";
import type { PlaceResult } from "./types";

export interface HoverIdentity {
  place: PlaceResult;
  /**
   * The FTS-derived `poi:<key>:<value>` category (or `address` / etc.)
   * from the reverse lookup. Used for icon selection AND the displayed
   * badge — never use the tile `subclass`/`class` for display.
   */
  category: string | null;
}

export interface HoverInput {
  lat: number;
  lon: number;
  /**
   * Optional tile-side hint. Allowed only as a tie-breaker or
   * short-circuit before the network call. Never displayed.
   */
  tileHint?: { class?: string | null; subclass?: string | null } | null;
}

export interface ResolveHoverDeps {
  reverse?: (lat: number, lon: number, radiusKm?: number) => Promise<PlaceResult | null>;
  signal?: AbortSignal;
}

const HOVER_RADIUS_KM = 0.05;

export async function resolveHoverIdentity(
  input: HoverInput,
  deps: ResolveHoverDeps = {},
): Promise<HoverIdentity | null> {
  const reverse =
    deps.reverse
    ?? ((lat: number, lon: number, radiusKm?: number) =>
      reverseGeocode(lat, lon, radiusKm, deps.signal));
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon)) {
    return null;
  }
  const place = await reverse(input.lat, input.lon, HOVER_RADIUS_KM);
  if (!place) {
    return null;
  }
  // `kind` is the GeocodeResult.category piped through `api.ts`.  The
  // tile hint is intentionally NOT used to override the displayed value.
  return { place, category: place.kind ?? null };
}

const NAME_SEARCH_MAX_KM = 0.5;

function geoDistKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371.0088;
  const f = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * f) / 2) ** 2 +
    Math.cos(a.lat * f) * Math.cos(b.lat * f) * Math.sin(((b.lon - a.lon) * f) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Full resolution for a named tile click: forward search first, reverse fallback.
 * When the fallback finds a co-located but differently-named POI (e.g. "Mobil"
 * when the user clicked "On the Run"), the tile name is kept but the address
 * is borrowed from the nearby POI so the card is never empty.
 */
export async function resolveNamedClick(
  tileName: string,
  near: { lat: number; lon: number },
  tileHint: { class?: string | null; subclass?: string | null } | null,
  signal?: AbortSignal,
): Promise<HoverIdentity | null> {
  const forward = await resolveByName(tileName, near, signal);
  if (forward) return forward;
  const fallback = await resolveHoverIdentity({ lat: near.lat, lon: near.lon, tileHint: tileHint ?? undefined });
  if (!fallback) return null;
  if (fallback.place.title.trim().toLowerCase() === tileName.trim().toLowerCase()) return fallback;
  return {
    place: { ...fallback.place, place_id: `tile:${near.lat.toFixed(6)},${near.lon.toFixed(6)}`, title: tileName },
    category: fallback.category,
  };
}

/** Forward name search + proximity filter — preferred for named POI label clicks. */
export async function resolveByName(
  name: string,
  near: { lat: number; lon: number },
  signal?: AbortSignal,
): Promise<HoverIdentity | null> {
  try {
    const { results } = await searchPlaces(
      name,
      near,
      signal ?? new AbortController().signal,
      { near },
    );
    let best: PlaceResult | null = null;
    let bestDist = NAME_SEARCH_MAX_KM;
    for (const r of results) {
      const d = geoDistKm(near, r);
      if (d < bestDist) { best = r; bestDist = d; }
    }
    return best ? { place: best, category: best.kind ?? null } : null;
  } catch {
    return null;
  }
}
