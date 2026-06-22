import type { PlaceResult } from "./types";

const STORAGE_KEY = "lokidoki.maps.last-view.v1";

export interface StoredMapView {
  center: { lat: number; lon: number };
  zoom: number;
  selectedPlace?: PlaceResult | null;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function isFiniteCoord(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizePlace(value: unknown): PlaceResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const place = value as Partial<PlaceResult>;
  if (
    typeof place.place_id !== "string" ||
    typeof place.title !== "string" ||
    typeof place.subtitle !== "string" ||
    !Array.isArray(place.address_lines) ||
    !isFiniteCoord(place.lat) ||
    !isFiniteCoord(place.lon)
  ) {
    return null;
  }
  return {
    place_id: place.place_id,
    title: place.title,
    subtitle: place.subtitle,
    address_lines: place.address_lines.filter((line): line is string => typeof line === "string"),
    lat: place.lat,
    lon: place.lon,
    kind: typeof place.kind === "string" ? place.kind : undefined,
  };
}

export function loadStoredMapView(): StoredMapView | null {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      center?: { lat?: unknown; lon?: unknown };
      zoom?: unknown;
      selectedPlace?: unknown;
    };
    if (
      !parsed.center ||
      !isFiniteCoord(parsed.center.lat) ||
      !isFiniteCoord(parsed.center.lon) ||
      !isFiniteCoord(parsed.zoom)
    ) {
      return null;
    }
    return {
      center: { lat: parsed.center.lat, lon: parsed.center.lon },
      zoom: parsed.zoom,
      selectedPlace: sanitizePlace(parsed.selectedPlace),
    };
  } catch {
    return null;
  }
}

export function saveStoredMapView(view: StoredMapView): void {
  if (
    !isFiniteCoord(view.center.lat) ||
    !isFiniteCoord(view.center.lon) ||
    !isFiniteCoord(view.zoom)
  ) {
    return;
  }
  storage()?.setItem(STORAGE_KEY, JSON.stringify(view));
}
