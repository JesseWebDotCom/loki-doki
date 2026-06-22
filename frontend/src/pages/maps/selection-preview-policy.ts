import type { HoverIdentity } from "./hover";
import type { PlaceResult } from "./types";

export function shouldSuppressSelectionPreview(
  selectedPlace: PlaceResult | null,
  hover: HoverIdentity | null,
): boolean {
  if (!selectedPlace || !hover) return false;
  return hover.place.place_id !== selectedPlace.place_id;
}

export function shouldShowSelectionPreview(
  selectedPlace: PlaceResult | null,
  hover: HoverIdentity | null,
  suppressed: boolean,
): boolean {
  if (!selectedPlace || suppressed) return false;
  if (!hover) return true;
  return hover.place.place_id === selectedPlace.place_id;
}
