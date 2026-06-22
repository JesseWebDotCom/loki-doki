import type { PlaceResult } from "./types";

const GEOCODE_URL = "/api/maps/geocode";
const REVERSE_GEOCODE_URL = "/api/maps/geocode/reverse";
const ROUTE_URL = "/api/maps/route";

export type RouterMode = "auto" | "pedestrian" | "bicycle" | "hiking" | "mtb";

export interface RouteRequestBody {
  origin: { lat: number; lon: number };
  destination: { lat: number; lon: number };
  waypoints: { lat: number; lon: number }[];
  profile: RouterMode;
  alternates: 0 | 1 | 2;
  avoid: { highways: boolean; tolls: boolean; ferries: boolean };
}

export interface RouteManeuverWire {
  text: string;
  distance_m: number;
  duration_s: number;
  sign: number;
  interval: [number, number];
  street_name: string | null;
}

export interface RouteWire {
  duration_s: number;
  distance_m: number;
  geometry: string;
  profile: RouterMode;
  legs: { steps: RouteManeuverWire[] }[];
}

export interface RouteResponseWire {
  routes: RouteWire[];
  instructions_text: string[];
  alternates: RouteWire[];
  mechanism_used: "graphhopper" | "osrm";
}

export class RouteUnavailableError extends Error {
  retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "RouteUnavailableError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function requestRoute(
  body: RouteRequestBody,
  signal: AbortSignal,
): Promise<RouteResponseWire> {
  const response = await fetch(ROUTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (response.status === 503) {
    const retry = response.headers.get("Retry-After");
    const seconds = retry ? Number(retry) : null;
    const detail = await safeReadDetail(response);
    throw new RouteUnavailableError(
      detail ?? "Routing unavailable. Install a region that covers both points or enable the online fallback.",
      Number.isFinite(seconds as number) ? (seconds as number) : null,
    );
  }
  if (!response.ok) {
    const detail = await safeReadDetail(response);
    throw new Error(`Route ${response.status}: ${detail ?? "request failed"}`);
  }
  return (await response.json()) as RouteResponseWire;
}

async function safeReadDetail(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    return typeof body.detail === "string" ? body.detail : null;
  } catch {
    return null;
  }
}

export interface ViewportCenter {
  lat: number;
  lon: number;
}

interface GeocodeRaw {
  place_id: string;
  title: string;
  subtitle: string;
  lat: number;
  lon: number;
  bbox: [number, number, number, number] | null;
  source: "fts" | "nominatim";
  category: string | null;
  phone?: string | null;
  website?: string | null;
  distance_m?: number | null;
  // Phase maps-discovery fields — passed through verbatim
  opening_hours_raw?: string | null;
  open_now?: boolean | null;
  closes_at?: string | null;
  opens_at?: string | null;
  business_attrs?: Record<string, unknown> | null;
  brand_qid?: string | null;
  wiki_summary?: string | null;
  wiki_url?: string | null;
  menu_url?: string | null;
}

export interface SearchResponse {
  results: PlaceResult[];
  fallback_used: boolean;
  offline: boolean;
}

export async function searchPlaces(
  query: string,
  viewportCenter: ViewportCenter | null,
  signal: AbortSignal,
  options?: { category?: string; near?: ViewportCenter | null },
): Promise<SearchResponse> {
  const trimmed = query.trim();
  const category = options?.category?.trim();
  if (!trimmed && !category) {
    return { results: [], fallback_used: false, offline: false };
  }
  const url = new URL(GEOCODE_URL, window.location.origin);
  if (trimmed) {
    url.searchParams.set("q", trimmed);
  }
  url.searchParams.set("limit", "10");
  if (viewportCenter) {
    url.searchParams.set("lat", String(viewportCenter.lat));
    url.searchParams.set("lon", String(viewportCenter.lon));
  }
  if (category) {
    url.searchParams.set("category", category);
  }
  if (options?.near) {
    url.searchParams.set("near", `${options.near.lat},${options.near.lon}`);
  }
  const response = await fetch(url.toString(), { signal });
  if (!response.ok) {
    throw new Error(`Geocoder ${response.status}`);
  }
  const body = (await response.json()) as {
    results: GeocodeRaw[];
    fallback_used?: boolean;
    offline?: boolean;
  };
  return {
    results: body.results.map(toPlaceResult).filter(isLocatable),
    fallback_used: Boolean(body.fallback_used),
    offline: Boolean(body.offline),
  };
}

export async function reverseGeocode(
  lat: number,
  lon: number,
  radiusKm = 0.05,
  signal?: AbortSignal,
): Promise<PlaceResult | null> {
  const url = new URL(REVERSE_GEOCODE_URL, window.location.origin);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("radius_km", String(radiusKm));
  const response = await fetch(url.toString(), { signal });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Reverse geocoder ${response.status}`);
  }
  return toPlaceResult((await response.json()) as GeocodeRaw);
}

function toPlaceResult(result: GeocodeRaw): PlaceResult {
  const address_lines = [result.title, result.subtitle].filter(Boolean);
  return {
    place_id: result.place_id,
    title: result.title || result.place_id,
    subtitle: result.subtitle || "",
    address_lines: address_lines.length ? address_lines : [result.place_id],
    lat: result.lat,
    lon: result.lon,
    kind: result.category ?? undefined,
    phone: result.phone ?? null,
    website: result.website ?? null,
    distance_m: result.distance_m ?? null,
    // Phase maps-discovery: pass all enrichment fields through
    opening_hours_raw: result.opening_hours_raw ?? null,
    open_now: result.open_now ?? null,
    closes_at: result.closes_at ?? null,
    opens_at: result.opens_at ?? null,
    business_attrs: result.business_attrs as PlaceResult["business_attrs"] ?? null,
    brand_qid: result.brand_qid ?? null,
    wiki_summary: result.wiki_summary ?? null,
    wiki_url: result.wiki_url ?? null,
    menu_url: result.menu_url ?? null,
  };
}

function isLocatable(place: PlaceResult): boolean {
  return Number.isFinite(place.lat) && Number.isFinite(place.lon);
}
