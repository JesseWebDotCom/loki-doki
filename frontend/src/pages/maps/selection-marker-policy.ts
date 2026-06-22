import type { PlaceResult } from "./types";

export function shouldRenderSelectionMarker(selectedPlace: PlaceResult | null): boolean {
  if (!selectedPlace) return false;
  // tile: IDs are unresolved fallbacks — no reliable coordinates for a pin.
  if (selectedPlace.place_id.startsWith("tile:")) return false;
  return true;
}
