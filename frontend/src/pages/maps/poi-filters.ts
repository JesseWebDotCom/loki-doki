import type { PlaceResult } from "./types";

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const f = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * f) / 2) ** 2 +
    Math.cos(a.lat * f) * Math.cos(b.lat * f) * Math.sin(((b.lon - a.lon) * f) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// True when the title or the first address line is a vague "near X" reference
// rather than a named place or real street address.
export function isNearPoi(place: PlaceResult): boolean {
  if (/^near\s+/i.test(place.title.trim())) return true;
  const firstLine = place.address_lines.find((l) => l.trim().length > 0);
  return Boolean(firstLine && /^near\s+/i.test(firstLine.trim()));
}

// Count populated fields as a proxy for data richness (used during dedup).
function richness(p: PlaceResult): number {
  let s = 0;
  if (p.phone) s++;
  if (p.website) s++;
  if (p.opening_hours_raw) s++;
  if (p.wiki_summary) s++;
  if (p.brand_qid) s++;
  if (p.business_attrs) s++;
  if (p.address_lines.some((l) => l.trim() && !/^near\s+/i.test(l.trim()))) s += 2;
  return s;
}

// Collapse same-name POIs within radiusM metres — keep the one with more data.
export function dedupePoiResults(places: PlaceResult[], radiusM = 100): PlaceResult[] {
  const out: PlaceResult[] = [];
  for (const place of places) {
    const norm = place.title.trim().toLowerCase();
    const dupIdx = out.findIndex(
      (o) => o.title.trim().toLowerCase() === norm && distanceM(o, place) <= radiusM,
    );
    if (dupIdx === -1) {
      out.push(place);
    } else if (richness(place) > richness(out[dupIdx])) {
      out[dupIdx] = place;
    }
  }
  return out;
}

// Remove near-only reference points then deduplicate by name + proximity.
export function filterAndDedupePoiResults(places: PlaceResult[], radiusM = 100): PlaceResult[] {
  return dedupePoiResults(
    places.filter((p) => !isNearPoi(p)),
    radiusM,
  );
}
