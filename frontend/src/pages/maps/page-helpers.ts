import { buildStyle } from "./style-factory";
import type { DeepLink, LayerMode } from "./types";

export const FALLBACK_CENTER: [number, number] = [-73.2, 44.1];
export const LABELS_URL = "/api/maps/tiles/_overview/world-labels.geojson";
export const COUNTRIES_URL = "/api/maps/tiles/_overview/world-countries.geojson";
export const STATES_URL = "/api/maps/tiles/_overview/world-states.geojson";
export const OVERVIEW_URL = "pmtiles:///api/maps/tiles/_overview/streets.pmtiles";
export const OVERLAY_MIN_ZOOM = 15;
export const OVERLAY_DEBOUNCE_MS = 350;

export function parseDeepLink(search: string): DeepLink | null {
  const params = new URLSearchParams(search);
  const from = parseLatLon(params.get("from"));
  const to = parseLatLon(params.get("to"));
  const focus = parseLatLon(params.get("focus"));
  const mode = params.get("mode");
  const q = params.get("q")?.trim() || "";
  const category = params.get("category")?.trim() || "";
  if (!from && !to && !focus && !mode && !q && !category) {
    return null;
  }
  return {
    fromPlace: from
      ? { place_id: "from", title: "From", subtitle: "", address_lines: [], lat: from.lat, lon: from.lon }
      : undefined,
    toPlace: to
      ? { place_id: "to", title: "To", subtitle: "", address_lines: [], lat: to.lat, lon: to.lon }
      : undefined,
    focusPlace: focus
      ? { place_id: "focus", title: q || "Selected place", subtitle: "", address_lines: [], lat: focus.lat, lon: focus.lon }
      : undefined,
    mode: mode === "pedestrian" || mode === "bicycle" ? mode : "auto",
    searchQuery: q || undefined,
    searchCategory: category || undefined,
  };
}

function parseLatLon(value: string | null): { lat: number; lon: number } | null {
  if (!value) return null;
  const [latText, lonText] = value.split(",");
  const lat = Number(latText);
  const lon = Number(lonText);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

export function buildRuntimeStyle(
  theme: "light" | "dark",
  tileUrl: string | null,
  layerMode: LayerMode,
) {
  return buildStyle(theme, tileUrl, OVERVIEW_URL, LABELS_URL, COUNTRIES_URL, STATES_URL, { mode: layerMode });
}

export function runtimeStyleKey(
  theme: "light" | "dark",
  tileUrl: string | null,
  layerMode: LayerMode,
): string {
  return `${theme}|${layerMode}|${tileUrl ?? "overview"}`;
}
