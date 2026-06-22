import type { PlaceResult } from "../types";

// Description comes entirely from the offline wiki_summary the backend pre-fetches
// from the ZIM file at index-build time. No external network calls — this feature
// must work offline.
export function usePlaceDescription(
  place: PlaceResult | null,
): { text: string; url?: string } | null {
  if (!place?.wiki_summary) return null;
  return { text: place.wiki_summary, url: place.wiki_url ?? undefined };
}
