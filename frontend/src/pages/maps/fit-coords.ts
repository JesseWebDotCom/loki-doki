/**
 * Camera "fit to coords" helper — ported verbatim from v1.
 *
 * Given a list of `[lng, lat]` coordinates this returns a single
 * action describing how to move the map: a `fly` to one point when
 * the coords collapse to a single distinct location, otherwise a
 * `fit` to the bounding box. Pure function for testability; the
 * `fitMapToCoords` helper applies the action to a real map.
 */
import type { Map as MapLibreMap } from "maplibre-gl";

export type RouteCoord = [number, number];

export interface FlyAction {
  kind: "fly";
  center: RouteCoord;
  zoom: number;
}

export interface FitAction {
  kind: "fit";
  bounds: [RouteCoord, RouteCoord];
  maxZoom: number;
}

export type FitCoordsAction = FlyAction | FitAction;

const NEARBY_EPSILON = 1e-6;
const FOCUS_ZOOM = 17;

function isValidCoord(coord: RouteCoord): boolean {
  const [lng, lat] = coord;
  return (
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90
  );
}

export function dedupeNearby(
  coords: RouteCoord[],
  epsilon = NEARBY_EPSILON,
): RouteCoord[] {
  const distinct: RouteCoord[] = [];
  for (const coord of coords) {
    if (!isValidCoord(coord)) continue;
    const last = distinct[distinct.length - 1];
    if (
      !last ||
      Math.abs(coord[0] - last[0]) > epsilon ||
      Math.abs(coord[1] - last[1]) > epsilon
    ) {
      distinct.push(coord);
    }
  }
  return distinct;
}

export function getFitCoordsAction(coords: RouteCoord[]): FitCoordsAction | null {
  const distinct = dedupeNearby(coords);
  if (distinct.length === 0) return null;
  if (distinct.length < 2) {
    return { kind: "fly", center: distinct[0], zoom: FOCUS_ZOOM };
  }
  let minLng = distinct[0][0];
  let minLat = distinct[0][1];
  let maxLng = distinct[0][0];
  let maxLat = distinct[0][1];
  for (const [lng, lat] of distinct) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return {
    kind: "fit",
    bounds: [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    maxZoom: FOCUS_ZOOM,
  };
}

// Cubic ease-out — fast start, gentle settle. Reads as cinematic rather
// than mechanical compared to the default sinusoidal ease.
const EASE_OUT_CUBIC = (t: number): number => 1 - Math.pow(1 - t, 3);
const CAMERA_DURATION_MS = 950;

export function fitMapToCoords(
  map: Pick<MapLibreMap, "fitBounds" | "flyTo">,
  coords: RouteCoord[],
): void {
  const action = getFitCoordsAction(coords);
  if (!action) return;
  if (action.kind === "fly") {
    map.flyTo({
      center: action.center,
      zoom: action.zoom,
      duration: CAMERA_DURATION_MS,
      curve: 1.6,
      essential: true,
      easing: EASE_OUT_CUBIC,
    });
    return;
  }
  map.fitBounds(action.bounds, {
    padding: 80,
    duration: CAMERA_DURATION_MS,
    maxZoom: action.maxZoom,
    essential: true,
    easing: EASE_OUT_CUBIC,
  });
}
